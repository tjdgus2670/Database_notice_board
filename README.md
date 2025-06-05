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
- **로그인 시 해싱 및 암호화 검증**
    - 해싱된 사용자 정보 확인
    - `salt`를 사용한 비밀번호 암호화 적용
- **ID/PW 찾기 기능**
    - 이름으로 ID 조회 가능
    - ID, 이름, 이메일을 통해 비밀번호 재설정 가능

---

### 📝 게시글 관련 기능

- **게시판 페이징 개선**
    - 현재 페이지 기준 `2`, `+2` 페이지만 출력
- **글쓰기 입력 유효성 검사**
    - 제목과 내용 미입력 시 등록 불가 처리
- **게시글 논리적 삭제 기능**
    - OK 필드를 `0`으로 설정하여 숨김 처리
    - OK = 1: 표시 / OK = 0: 비표시

---

### 💬 댓글 및 대댓글 기능

- **대댓글 기능**
    - 댓글에 대한 대댓글 구현
    - 댓글보다 안쪽으로 들여써서 계층 시각화
- **댓글 논리적 삭제 기능**
    - OK 필드를 `0`으로 설정
    - “삭제된 댓글입니다” 문구로 대체 출력

---

### 👍 좋아요 / 👎 싫어요 기능

- **중복 방지 및 인증 제한**
    - 좋아요/싫어요 중복 방지 처리
    - 로그인한 사용자만 사용 가능

---

### 📁 파일 업로드 기능

- **파일 저장 경로 지정**
    - `/public/uploads` 폴더에 업로드 파일 저장

---

### 👤 사용자 인터페이스 개선

- **상태별 버튼 노출 제어**
    - 로그인 시: 글쓰기, 로그아웃, 정보수정 버튼 표시
    - 로그아웃 시: 로그인, 회원가입 버튼 표시
- **로그인 환영 메시지**
    - 좌측 하단에 `환영합니다 ***님!` 메시지 출력
