## 📂 테이블 생성 SQL

### 🗂️ BBS 테이블 (게시글 저장 테이블)

```sql
CREATE TABLE BBS (
    NO NUMBER(10, 0) NOT NULL,
    TITLE VARCHAR2(255 BYTE),
    WRITER VARCHAR2(255 BYTE),
    CONTENT VARCHAR2(4000 BYTE),
    REGDATE DATE,
    OK NUMBER(1, 0) DEFAULT 1,
    COUNT NUMBER(38, 0) DEFAULT 0,
    FILE_PATH VARCHAR2(255 BYTE),
    ORIGINAL_FILE_NAME VARCHAR2(255 BYTE),
    CONSTRAINT PK_BOARD_POSTS PRIMARY KEY (NO)
);
```


🗂️ BBSW 테이블 (댓글/대댓글 저장 테이블)
```sql
CREATE TABLE BBSW (
    NO NUMBER(10, 0) NOT NULL,
    BBS_NO NUMBER(10, 0),
    WRITER VARCHAR2(255 BYTE),
    CONTENT VARCHAR2(1024 BYTE),
    REGDATE DATE,
    WCOUNT NUMBER(4, 0) DEFAULT 0,
    OK NUMBER(1, 0) DEFAULT 1,
    PARENT_NO NUMBER(38, 0),
    GOOD NUMBER DEFAULT 0,
    BAD NUMBER DEFAULT 0,
    DEPTH NUMBER DEFAULT 0,
    GROUP_ID NUMBER NOT NULL DEFAULT 0,
    ORDER_IN_GROUP NUMBER NOT NULL DEFAULT 0,
    CONSTRAINT PK_BBS_POSTS PRIMARY KEY (NO)
);
```
🗂️ USERS 테이블 (회원 정보 저장 테이블)
```sql
CREATE TABLE USERS (
    ID VARCHAR2(255 BYTE) NOT NULL,
    PASSWORD VARCHAR2(1024 BYTE) NOT NULL,
    NAME VARCHAR2(256 BYTE) NOT NULL,
    EMAIL VARCHAR2(1024 BYTE),
    OK NUMBER(1, 0) DEFAULT 1,
    SALT VARCHAR2(48 BYTE),
    CONSTRAINT PK_USERS PRIMARY KEY (ID)
);
```
🗂️ BBSW_LIKES 테이블 (댓글 좋아요/싫어요 기록 테이블)
```sql
CREATE TABLE BBSW_LIKES (
    USER_ID VARCHAR2(50) NOT NULL,
    COMMENT_NO NUMBER NOT NULL,
    VOTE_TYPE NUMBER(1) NOT NULL,
    REGDATE DATE DEFAULT SYSDATE,
    PRIMARY KEY (USER_ID, COMMENT_NO)
);
```
## 🛠️ 게시판 기능 구현 내역

### 🔐 사용자 보안 기능

- **정보수정 시 비밀번호 필드 보안 강화**
    - 비밀번호 입력란은 빈 칸으로 설정
    - `input type="password"`로 보안성 향상

![image.png](attachment:dcb1415a-5ba8-4eda-9a38-0d04901eeff5:image.png)

- **로그인 시 해싱 및 암호화 검증**
    - 해싱된 사용자 정보 확인
    - `salt`를 사용한 비밀번호 암호화 적용
    - migrate-password.js 파일을 추가시켜서 해싱되지 않은 계정에 해싱 적용

![image.png](attachment:e0fc9a90-6beb-41d4-a477-e28ab0e7d94d:image.png)

- **ID/PW 찾기 기능**
    - 이름으로 ID 조회 가능
    - ID, 이름, 이메일을 통해 비밀번호 재설정 가능
- 로그인 페이지

![image.png](attachment:3c661ff0-6775-456a-aa4a-3321752199fa:image.png)

- 아이디 찾기

![image.png](attachment:3449a36f-5b0d-462c-9f5d-09a34e880ef2:image.png)

- 비밀번호 재설정

![image.png](attachment:21619537-d91e-41fd-9cf3-9840f4d30a2c:image.png)

---

### 📝 게시글 관련 기능

- **게시판 페이징 개선**
    - 현재 페이지 기준 `2`, `+2` 페이지만 출력

![image.png](attachment:81051d19-0515-49d6-ab19-4c7a662ad4bd:image.png)

- **글쓰기 입력 유효성 검사**
    - 제목과 내용 미입력 시 등록 불가 처리

![image.png](attachment:97f66a0d-c6cd-4021-ba31-f1da32988d9c:image.png)

- **게시글 논리적 삭제 기능**
    - OK 필드를 `0`으로 설정하여 숨김 처리
    - OK = 1: 표시 / OK = 0: 비표시

![image.png](attachment:4acfd10d-9b8c-49b0-9ef9-8712959ead91:image.png)

---

### 💬 댓글 및 대댓글 기능

- **대댓글 기능**
    - 댓글에 대한 대댓글 구현
    - 댓글보다 안쪽으로 들여써서 계층 시각화

![image.png](attachment:72dd0c5f-99a5-41c4-b7c1-ad94c82cea8c:image.png)

- **댓글 논리적 삭제 기능**
    - OK 필드를 `0`으로 설정
    - “삭제된 댓글입니다” 문구로 대체 출력

![image.png](attachment:0ea285f0-fae5-4009-9d7b-fb6b98b1d402:image.png)

---

### 👍 좋아요 / 👎 싫어요 기능

- **중복 방지 및 인증 제한**
    - 좋아요/싫어요 중복 방지 처리
    - 로그인한 사용자만 사용 가능
- 로그인 한 사용자의 화면

![image.png](attachment:dc720c2c-8747-426a-bff4-18b2635c8612:image.png)

- 로그인 하지 않은 사용자의 화면

![image.png](attachment:5a455c83-4450-4615-a98a-1da24c1b42da:image.png)

---

### 📁 파일 업로드 기능

- **파일 저장 경로 지정**
    - `/public/uploads` 폴더에 업로드 파일 저장

![image.png](attachment:1b27ff34-49c2-4ff9-9ee2-876b152582c6:image.png)

---

### 👤 사용자 인터페이스 개선

- **상태별 버튼 노출 제어**
    - 로그인 시: 글쓰기, 로그아웃, 정보수정 버튼 표시
    
    ![image.png](attachment:0ec2ceb0-5c92-4fa8-a351-480b59b53ccd:image.png)
    
    - 로그아웃 시: 로그인, 회원가입 버튼 표시
    
    ![image.png](attachment:7eb3e496-3e3a-4e02-a9b0-e491e0f8eb2c:image.png)
    

- **로그인 환영 메시지**
    - 좌측 하단에 `환영합니다 ***님!` 메시지 출력
