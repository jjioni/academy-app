# 인터넷 주소로 배포하기 (GitHub + Render, 무료)

코딩 지식 없이도 따라 할 수 있는 배포 순서입니다. 완료하면 `https://academy-압구정.onrender.com` 같은 실제 인터넷 주소가 생깁니다.

## 0단계. 먼저 알아둘 점 (중요)

현재 이 앱은 데이터를 `data/db.json` 파일에 저장합니다. **Render 무료 요금제는 서버를 재배포하거나 일정 시간 미사용 시 파일이 초기화될 수 있습니다.** 즉, 무료로 먼저 테스트해보고 실제 운영(회원 데이터가 쌓이는 단계)에 들어갈 땐 유료 플랜 + 영구 디스크(Persistent Disk) 옵션을 켜야 데이터가 안전합니다. (Railway는 무료/저가 플랜에서도 볼륨(디스크) 옵션을 제공하는 경우가 많으니, 가입 시점에 각 서비스 요금제 페이지에서 "Persistent Disk / Volume" 여부를 확인해 주세요 — 서비스마다 정책이 자주 바뀝니다.)

## 1단계. GitHub에 코드 올리기

1. https://github.com 가입 (무료)
2. 우측 상단 `+` → `New repository` → 이름을 `academy-app`으로 입력 → `Create repository`
3. 방금 받은 `academy-app.zip` 압축을 컴퓨터에서 풀기
4. 생성된 저장소 페이지에서 `uploading an existing file` 클릭 → 압축 푼 폴더 안의 **모든 파일과 폴더**를 드래그해서 업로드 → 하단 `Commit changes` 클릭

## 2단계. Render 가입 및 배포

1. https://render.com 접속 → GitHub 계정으로 가입
2. 대시보드에서 `New +` → `Web Service` 클릭
3. 방금 만든 `academy-app` 저장소 선택
4. 아래 값 입력
   - **Name**: 원하는 이름 (예: academy-압구정)
   - **Runtime**: Node
   - **Build Command**: `node seed.js`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. `Create Web Service` 클릭 → 2~3분 기다리면 빌드/배포 완료
6. 화면 상단에 뜨는 `https://academy-압구정.onrender.com` 같은 주소가 실제 접속 주소입니다

## 3단계. 접속 확인

주소로 접속해 로그인 화면이 뜨는지 확인하세요. 기본 계정(README.md 참고)으로 로그인해 정상 동작하는지 확인한 뒤, 마스터 계정으로 강사/관리자를 승인하고 실제 운영을 시작하시면 됩니다.

## 나중에 코드를 수정하고 싶다면

GitHub 저장소에서 해당 파일을 열어 연필 아이콘(Edit) 클릭 → 수정 → `Commit changes`. Render는 GitHub와 연결되어 있어 커밋할 때마다 자동으로 재배포됩니다.

## 막히는 부분이 있다면

Render 대시보드의 `Logs` 탭에서 에러 메시지를 확인할 수 있습니다. 에러 메시지를 캡처해서 알려주시면 원인을 같이 봐드릴게요.
