// Minimal Google API client built on Node's built-in `crypto` + `https` only
// (no `googleapis` npm package — this sandbox has no npm registry access, and
// keeping it dependency-free also means nothing to `npm install` on Render).
//
// Implements just enough of the OAuth2 service-account flow to:
//  - get an access token (JWT bearer grant, RS256-signed)
//  - upload a file to Google Drive (multipart upload)
//  - append a row to a Google Sheet (Sheets API v4)
//
// Configure via environment variables (set these in Render's dashboard, never commit them):
//   GOOGLE_CLIENT_EMAIL   - service account email (from the downloaded JSON key)
//   GOOGLE_PRIVATE_KEY    - service account private key (from the downloaded JSON key;
//                            keep the \n escapes literal if pasting into Render's UI)
//   GOOGLE_DRIVE_FOLDER_ID - Drive folder ID to upload ID/bankbook photos into
//   GOOGLE_SHEET_ID        - spreadsheet ID to mirror app data into
//
// If these aren't set, every function here becomes a safe no-op so the rest of the
// app keeps working without Google integration configured.

const crypto = require('crypto');
const https = require('https');

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY);
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedToken = null; // { token, expiresAt }

function requestJson(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(`Google API ${res.statusCode}: ${data}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAccessToken(scopes) {
  if (!isConfigured()) throw new Error('Google 서비스 계정이 설정되지 않았습니다 (GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY).');
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30000) return cachedToken.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: process.env.GOOGLE_CLIENT_EMAIL,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey);
  const jwt = `${unsigned}.${signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(jwt)}`;
  const resp = await requestJson({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);

  cachedToken = { token: resp.access_token, expiresAt: Date.now() + (resp.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

// Uploads a base64-encoded file to Drive using multipart/related upload.
// Returns { id, webViewLink } or null if Google isn't configured.
async function uploadToDrive(fileName, mimeType, base64Data) {
  if (!isConfigured() || !process.env.GOOGLE_DRIVE_FOLDER_ID) return null;
  const token = await getAccessToken(['https://www.googleapis.com/auth/drive.file']);
  const boundary = 'academyapp' + crypto.randomBytes(8).toString('hex');
  const metadata = JSON.stringify({ name: fileName, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] });
  const fileBuffer = Buffer.from(base64Data, 'base64');

  const preamble =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;
  const bodyBuffer = Buffer.concat([
    Buffer.from(preamble, 'utf8'),
    Buffer.from(fileBuffer.toString('base64'), 'utf8'),
    Buffer.from(closing, 'utf8')
  ]);

  const resp = await requestJson({
    hostname: 'www.googleapis.com',
    path: '/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': bodyBuffer.length
    }
  }, bodyBuffer);
  return resp; // { id, webViewLink }
}

// Appends a row to a sheet tab. Creates the tab first if it doesn't exist.
// `tabName` e.g. '앱_수강생' / '앱_출석' / '앱_결제'. `values` is an array of cell values.
const knownTabs = new Set();
async function appendSheetRow(tabName, values) {
  if (!isConfigured() || !process.env.GOOGLE_SHEET_ID) return null;
  const token = await getAccessToken(['https://www.googleapis.com/auth/spreadsheets']);
  const sheetId = process.env.GOOGLE_SHEET_ID;

  if (!knownTabs.has(tabName)) {
    await ensureTabExists(token, sheetId, tabName);
    knownTabs.add(tabName);
  }

  const range = encodeURIComponent(`${tabName}!A1`);
  const body = JSON.stringify({ values: [values] });
  return requestJson({
    hostname: 'sheets.googleapis.com',
    path: `/v4/spreadsheets/${sheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, body);
}

async function ensureTabExists(token, sheetId, tabName) {
  try {
    const meta = await requestJson({
      hostname: 'sheets.googleapis.com', path: `/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
      method: 'GET', headers: { Authorization: `Bearer ${token}` }
    });
    const exists = (meta.sheets || []).some(s => s.properties.title === tabName);
    if (exists) return;
  } catch (e) { /* fall through and try to create it anyway */ }
  const body = JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] });
  try {
    await requestJson({
      hostname: 'sheets.googleapis.com', path: `/v4/spreadsheets/${sheetId}:batchUpdate`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, body);
  } catch (e) { /* tab may already exist from a race, ignore */ }
}

module.exports = { isConfigured, uploadToDrive, appendSheetRow };
