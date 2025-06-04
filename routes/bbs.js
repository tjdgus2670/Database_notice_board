var express = require('express');
var router = express.Router();
var oracledb = require('oracledb');
var crypto = require('crypto');
const session = require('express-session');
const migrateUnhashedPasswords = require('../migrate-password');
var multer = require('multer'); // multer 모듈 추가
var path = require('path'); // 파일 경로 처리를 위해 path 모듈 추가
const fs = require('fs'); // 파일 삭제를 위해 fs 모듈 추가

// !!! 중요 !!! autoCommit 설정을 false로 변경했습니다.
// 수동 트랜잭션 관리를 위해 필요합니다.
oracledb.autoCommit = false; // <<< 이 부분이 변경되었습니다!

var dbconfig = {
    user : "TEST_USER",
    password : "1234",
    connectString : "localhost/XEPDB1"
};
router.get('/read', async function(req,res,next){
    console.log(`[Info] /read: 게시글 조회 요청 (NO: ${req.query.brdno})`);

    let connection;
    try {
        const retBBS = await read_bbs(req.query.brdno);
        if (!retBBS || retBBS.rows.length === 0) {
            console.warn(`[Warning] /read: 게시글 (NO: ${req.query.brdno})을 찾을 수 없음.`);
            return res.render('bbs/error', { errcode: 404 });
        }

        connection = await oracledb.getConnection(dbconfig);

        const userId = req.session.user ? req.session.user.id : null;

        // !!! 여기부터 댓글 조회 SQL이 변경됩니다 !!!
        // Oracle의 계층 쿼리 (CONNECT BY)를 사용하여 대댓글 구조를 올바르게 정렬합니다.
        // SYS_CONNECT_BY_PATH 함수를 사용하여 경로를 생성하고, 이를 정렬 기준으로 활용합니다.
        // ORDER SIBLINGS BY REGDATE ASC, NO ASC 는 같은 레벨(형제) 댓글들을 정렬합니다.
        // 계층 쿼리에서는 ORDER_IN_GROUP 컬럼을 직접 업데이트하고 관리하는 것보다
        // CONNECT BY와 LEVEL, ORDER SIBLINGS BY를 사용하는 것이 더 안전하고 강력합니다.
        var wbbsSql = `
            SELECT
                BBSW.NO, BBSW.BBS_NO, BBSW.WRITER, BBSW.CONTENT,
                to_char(BBSW.REGDATE,'yyyy-mm-dd hh24:mi:ss') AS REGDATE_FORMATTED,
                BBSW.WCOUNT, BBSW.OK, BBSW.PARENT_NO, BBSW.DEPTH,
                BBSW.GROUP_ID, BBSW.ORDER_IN_GROUP, BBSW.GOOD, BBSW.BAD,
                LEVEL AS HIERARCHY_LEVEL, -- 계층 레벨 (들여쓰기용)
                (SELECT VOTE_TYPE FROM BBSW_LIKES WHERE USER_ID = :userId AND COMMENT_NO = BBSW.NO) AS MY_VOTE_TYPE
            FROM BBSW
            START WITH PARENT_NO IS NULL AND BBS_NO = :bbs_no -- 최상위 댓글부터 시작
            CONNECT BY PRIOR NO = PARENT_NO AND BBS_NO = PRIOR BBS_NO -- 부모-자식 관계 정의
            ORDER SIBLINGS BY REGDATE ASC, NO ASC -- 형제 댓글들을 등록일자, 번호 순으로 정렬
        `;
        console.log(`[Info] /read: 댓글 조회 SQL (계층 쿼리): ${wbbsSql}`);
        const wbbsRows = await connection.execute(wbbsSql, { bbs_no: req.query.brdno, userId: userId });
        console.log(`[Info] /read: 댓글 ${wbbsRows.rows.length}개 조회됨.`);

        res.render('bbs/read', {bbs: retBBS, wbbs: wbbsRows.rows, loggedInUser: req.session.user});

    } catch (err) {
        console.error(`[Error] /read: 게시글/댓글 조회 중 오류 발생: ${err.message}`, err.stack);
        res.render('bbs/error', {errcode: 500});
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (e) { console.error(`[Error] /read: DB 연결 해제 중 오류: ${e.message}`, e.stack); }
        }
    }
});
// 파일이 업로드될 디렉토리 설정 (프로젝트 루트의 'public/uploads' 디렉토리)
// 이 디렉토리는 수동으로 생성해주어야 합니다!
const UPLOAD_DIR = path.join(__dirname, '../public/uploads');

// Multer Storage 설정
var storage = multer.diskStorage({
    destination: function (req, file, cb) {
        // public/uploads 디렉토리가 없으면 생성 (선택 사항이지만 유용함)
        if (!fs.existsSync(UPLOAD_DIR)) {
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        }
        cb(null, UPLOAD_DIR); // 파일이 저장될 경로
    },
    filename: function (req, file, cb) {
        // 파일 이름 설정: 고유한 이름 + 원본 확장자
        // 예: userfile-1678881234567-123456789.png
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
// Multer 업로드 미들웨어 생성
// 'upload' 변수를 사용하여 파일 업로드를 처리합니다.
var upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB로 파일 크기 제한 (선택 사항)
    fileFilter: function (req, file, cb) {
        // 파일 타입 필터링 (선택 사항)
        // 이미지 파일만 허용하는 예시 (필요에 따라 주석 처리 또는 수정)
        const filetypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|ppt|pptx/; // 이미지, PDF, Office 파일 등 허용
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error("Unsupported file type. Only common document/image types are allowed."));
    }
});
router.get('/', function(req, res, next) {
    res.redirect('/bbs/list');
});

router.get('/login', function(req, res, next) {
    var code = 0;
    if(req.session.user)    code = 3;
    res.render('bbs/login', {errcode : code});
});
router.get('/logout', function(req, res, next) {
    
    if(req.session.user)    req.session.destroy();

    res.redirect('/bbs/list');    
});
router.get('/signup', function(req, res, next) {
    var code = 0;
    if( req.session.user )    code = 1;
    res.render('bbs/signup', {code : code});    
});
router.post('/signupsave', function(req, res, next) {
    var id = req.body.id, pw1 = req.body.pw1, pw2 = req.body.pw2;
    var name = req.body.name;
    var email = req.body.email;
    var code = 0 ; // 1-두개의 패스워드 틀린경우  
    
    if( pw1 != pw2)
    {
        code = 1;
        res.render('bbs/error', {errcode : code});
        return;
    }
    if( id == ""  
|| pw1 == "" || name == "")
    {
        code = 2;
        res.render('bbs/error', {errcode : code});
        return;
    }

    var salt = Math.round(new Date().valueOf()*Math.random()) + "";
    var hashPassword = crypto.createHash("sha512").update(pw1+salt).digest("base64");

    console.log("salt : "+salt);
    console.log("hashPassword : "+hashPassword);

    var sql = "INSERT INTO LOGIN(ID, PASSWORD, NAME, EMAIL, SALT, OK) " + "VALUES('" + id + "','" + hashPassword + "','" +  
name + "','" + email + "','" + salt + "', 1)";     
    
    console.log("sql :"+sql);
    oracledb.getConnection(dbconfig, function(err,connection){
        
        connection.execute(sql, function(err, result){
            if(err)
            {
                code = 3;
res.render('bbs/error', {errcode : code});
                return;
            } 

            res.redirect('/bbs/login');
        });
});
});


router.get('/updatesignup',function(req,res,next) {
    var code = 0;

    if(req.session.user)
    {
        oracledb.getConnection(dbconfig,function(err,connection){
            var sql = "SELECT ID, PASSWORD, NAME, EMAIL FROM LOGIN WHERE ID = '"+req.session.user.id+"'";
            console.log("sql : "+sql);
            connection.execute(sql,function(err,rows){
                if(err) console.error("err : "+ err);

  
               res.render('bbs/updatesignform', rows);
                connection.release();
           });
        });
    }
    else
    {
        code = 4;
        res.render('bbs/error', {errcode : code});
        return;
    }
});
router.post('/updatesignsave', function(req, res, next) {
    var id = req.body.id, pw = req.body.pw1, name = req.body.name, email = req.body.email;

    var salt = Math.round(new Date().valueOf() * Math.random()) + "";
    var hashPassword = crypto.createHash("sha512").update(pw + salt).digest("base64");

    oracledb.getConnection(dbconfig, function(err, connection) {
        var sql = "UPDATE LOGIN SET PASSWORD = '" + hashPassword + "', SALT = '" + salt + "'," + 
                  " NAME = '" + name  
+ "', EMAIL = '" + email + "' WHERE ID = '" + id + "'";

        console.log("sql : " + sql);
        connection.execute(sql, function(err, rows) {
            if (err) console.error("err : " + err);
            res.redirect('/bbs/list');
            connection.release();
        });
    });
});
router.post('/logincheck', async function(req, res, next) {
    var id = req.body.id;
    var pw = req.body.password;
    var code = 0;

    let connection;
    try {
        // 1) 로그인 검증 전에 마이그레이션 수행
        await migrateUnhashedPasswords();
// 2) DB 연결 후 사용자 조회
        connection = await oracledb.getConnection(dbconfig);
const selectSql = "SELECT OK, PASSWORD, SALT FROM LOGIN WHERE ID = :id";
const result = await connection.execute(selectSql, { id });

        // 2-1) 해당 ID가 없는 경우
        if (!result.rows || result.rows.length < 1) {
            console.log('로그인 아이디가 없습니다.');
code = 1; // errcode 1: 아이디 없음
            return res.render('bbs/login', { errcode: code });
}

        // 2-2) 결과에서 OK, DB 비밀번호, SALT 추출
        const [okValue, dbHashPassword, dbSalt] = result.rows[0];
// 3) OK 검사 (0이거나 1이 아닌 값이면 비활성 계정)
        if (okValue !== 1) {
            console.log("비활성 계정으로 로그인 불가: OK =", okValue);
code = 6; // errcode 6: 비활성화 계정
            return res.render('bbs/login', { errcode: code });
}

        // 4) dbSalt는 이미 마이그레이션이 끝났으므로 항상 “해시된 상태”가 되어 있어야 함
        //    (만약 migrateUnhashedPasswords 에서 예외가 발생하여 일부만 해싱된 상태라면
        //     그 계정은 다음 코드에서 평문 비교가 아닌 해시 비교로 넘어감)
        const hashPassword = crypto
            .createHash("sha512")
            .update(pw + dbSalt)
   
          .digest("base64");
// 5) 해시 비교
        if (hashPassword !== dbHashPassword) {
            console.log("패스워드가 틀렸습니다.");
code = 2; // errcode 2: 비밀번호 오류
            return res.render('bbs/login', { errcode: code });
}

        // 6) 로그인 성공 → 세션 생성
        if (!req.session.user) {
            console.log("새로운 세션을 만듭니다.");
req.session.user = {
                id          : id,
                authorized  : true
            };
}

        // 7) 로그인 완료 후 목록 페이지로 리디렉션
        return res.redirect('/bbs/list');
} catch (err) {
        console.error("로그인 처리 중 오류:", err);
return res.render('bbs/error', { errcode: 500 });
    } finally {
        if (connection) {
            try { await connection.close();
}
            catch (e) { console.error(e);
}
        }
    }
});
async function countRecord(){
    return new Promise(function(resolve,reject) {
        oracledb.getConnection(dbconfig,function(err,connection) {
            if (err) {
                console.error("DB connection error:", err);
                return reject(err);
            }
            var sql = "SELECT COUNT(*) FROM BBS WHERE " + 
"OK = 1"; // OK = 1 인 활성화된 게시글만 카운트
            connection.execute(sql,function(err,count){
                if(err) {
                    console.error("Error counting active records: " + err);
                    connection.release();
               
      reject(err);
                    return;
                }
                var totalRecords=parseInt(count.rows[0][0]); // Oracle의 COUNT(*) 결과는 [[숫자]] 형태이므로 [0][0] 접근
                console.log("Total Active Records is "+totalRecords);
              
   connection.release();
                resolve(totalRecords);
            });
        });
    });
}

router.get('/list',async function(req,res,next) {
    var stNum=0, totalRecords=0, totalPage=0, firstPage=0, lastPage=0, currentPage=1, blockSize=5, pageSize=5;

    countRecord().then(function(totalRecordsCount) {
        totalRecords = totalRecordsCount;
        if(req.query.currentPage!=undefined) currentPage=parseInt(req.query.currentPage);

        totalPage=Math.ceil(totalRecords/pageSize);

        firstPage = Math.max(1, currentPage - 2);
        lastPage  = Math.min(totalPage, currentPage + 2);
        stNum=(currentPage-1)*pageSize;

        oracledb.getConnection(dbconfig,function(err,connection){
           
  if (err) {
                console.error("DB connection error:", err);
                return res.render('bbs/error', { errcode: 500 });
            }

            // SQL 쿼리에 OK = 1 조건 추가
            // data.rows에서 'OK' 컬럼의 인덱스는 현재 5번이므로, FILE_PATH, ORIGINAL_FILE_NAME이 추가되면 7, 8번으로 변경됩니다.
  
           // 따라서 SELECT 문에 명시적으로 OK 컬럼을 포함시키고 인덱스를 확인해야 합니다.
var sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK, COUNT, FILE_PATH, ORIGINAL_FILE_NAME" + 
                                " FROM BBS WHERE OK = 1 ORDER BY NO DESC OFFSET "+stNum+" ROWS FETCH NEXT "+pageSize+" ROWS ONLY";
connection.execute(sql,function(err,rows){
                if(err) {
                    console.error("err : "+err);
                    connection.release();
                    return res.render('bbs/error', { errcode: 500 });
                
}

                console.log(rows);
                res.render('bbs/list', {data:rows,currentPage:currentPage,totalRecords:totalRecords,pageSize:pageSize, 
                                         totalPage:totalPage,blockSize:blockSize,firstPage:firstPage,lastPage:lastPage, 
                          
                stNum:stNum, loggedInUser: req.session.user}); // loggedInUser 추가
                connection.release();
            });
});
    }).catch(function(error) {
        console.error("Error in countRecord:", error);
        res.render('bbs/error', { errcode: 500, message: "게시글 수를 불러오는 중 오류가 발생했습니다." });
    });
});

router.get('/form',function(req,res,next){
    if(req.session.user)
        res.render('bbs/form', {id: req.session.user.id});
    else
        res.render('bbs/form', {id:0});
});
// 파일 업로드 처리를 위해 upload.single('userfile') 미들웨어 추가
router.post('/save', upload.single('userfile'), function(req,res,next){
    const { brdtitle, brdmemo, brdwriter } = req.body; // 구조 분해 할당으로 가독성 높임
    let code = 0;

    // 서버 측 유효성 검사 추가
    if (!brdtitle || brdtitle.trim() === '') {
        console.warn(`[Warning] /save: 제목이 비어있어 게시글 작성을 거부합니다.`);
        code = 7; // 에러 코드 7: 제목 필수
        return res.render('bbs/error', { errcode: code, message: "제목은 필수 입력 사항입니다."  
});
    }
    if (!brdmemo || brdmemo.trim() === '') {
        console.warn(`[Warning] /save: 내용이 비어있어 게시글 작성을 거부합니다.`);
        code = 8; // 에러 코드 8: 내용 필수
        return res.render('bbs/error', { errcode: code, message: "내용은 필수 입력 사항입니다." });
    }
    
    oracledb.getConnection(dbconfig,function(err,connection){
        if (err) {
            console.error("DB connection error:", err);
 
            return res.render('bbs/error', { errcode: 500 });
        }

        let filePath = null;
        let originalFileName = null;
if (req.fileValidationError) {
            console.error("File upload validation error:", req.fileValidationError);
            connection.release();
return res.render('bbs/error', { errcode: 400, message: req.fileValidationError.message });
        }

        if (req.file) {
            filePath = '/uploads/' + req.file.filename;
originalFileName = req.file.originalname;
            console.log("Uploaded file:", req.file);
            console.log("File path for DB:", filePath);
}

        // SQL 쿼리 수정: OK 컬럼에 1을 삽입
        const sql = "INSERT INTO BBS(NO, TITLE, CONTENT, WRITER, REGDATE, FILE_PATH, ORIGINAL_FILE_NAME, OK) " + 
                            "VALUES(bbs_seq.nextval, :title, :content, :writer, SYSDATE, :filePath, :originalFileName, :ok)";
// OK 컬럼 추가
        
        const binds = {
            title: brdtitle,
            content: brdmemo,
            writer: brdwriter,
            filePath: filePath,
            originalFileName: originalFileName,
            ok:  
1 // 새 게시글은 기본적으로 활성화 (OK=1)
        };
connection.execute(sql, binds, { autoCommit: true }, function(err, result){  
            if(err) {
                console.error("DB execute error:", err);
                if (req.file) {
                    fs.unlink(req.file.path, (unlinkErr) => {
                   
      if (unlinkErr) console.error("Error deleting uploaded file:", unlinkErr);
                    });
                }
                connection.release();
                return res.render('bbs/error', { errcode: 500 });
            } 
  
           
            console.log("Rows affected:", result.rowsAffected);
            res.redirect('/bbs/list');
            connection.release();
        });
});
});

router.get('/read_count',function(req,res,next){
    oracledb.getConnection(dbconfig,function(err,connection){

        console.log("brd : "+req.query.brdno);

        var sql = "UPDATE BBS SET COUNT = COUNT +'"+ 1 +"' WHERE NO="+req.query.brdno;
        
        console.log("SQL : "+sql);
        
        connection.execute(sql,function(err,rows){
            if(err) console.error("err : "+err);
            console.log("rows : " + 
" "+JSON.stringify(rows));

            res.redirect('/bbs/read?brdno='+req.query.brdno);
            connection.release();
        });
    });
});
async function read_bbs(brdno){
    return new Promise(function(resolve,reject) {
        oracledb.getConnection(dbconfig,function(err,connection) {
            if (err) {
                console.error("DB connection error:", err);
                return reject(err);
            }
            // SQL 쿼리 수정: OK = 1 조건  
            var sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK, COUNT, FILE_PATH, ORIGINAL_FILE_NAME FROM BBS "+ 
                              " WHERE NO = :brdno AND OK = 1"; // 활성화된 게시글만 조회

            connection.execute(sql, { brdno: brdno }, function(err,retBBS){
             
    if(err) {
                    console.error("err : " + err);
                    connection.release();
                    reject(err);
                } else {
              
       connection.release();
                    resolve(retBBS);
                }
            });
        });
    });
}

router.get('/read', async function(req,res,next){
    console.log(`[Info] /read: 게시글 조회 요청 (NO: ${req.query.brdno})`);

    let connection;
    try {
        const retBBS = await read_bbs(req.query.brdno);
        if (!retBBS || retBBS.rows.length === 0) {
            console.warn(`[Warning] /read: 게시글 (NO: ${req.query.brdno})을 찾을 수 없음.`);
            return res.render('bbs/error', { errcode: 404 });
        }

        connection = await oracledb.getConnection(dbconfig);

        const userId = req.session.user ? req.session.user.id : null;

        // !!! 여기부터 댓글 조회 SQL이 변경됩니다 !!!
        // Oracle의 계층 쿼리 (CONNECT BY)를 사용하여 대댓글 구조를 올바르게 정렬합니다.
        // SYS_CONNECT_BY_PATH 함수를 사용하여 경로를 생성하고, 이를 정렬 기준으로 활용합니다.
        // ORDER SIBLINGS BY REGDATE ASC, NO ASC 는 같은 레벨(형제) 댓글들을 정렬합니다.
        // 계층 쿼리에서는 ORDER_IN_GROUP 컬럼을 직접 업데이트하고 관리하는 것보다
        // CONNECT BY와 LEVEL, ORDER SIBLINGS BY를 사용하는 것이 더 안전하고 강력합니다.
        var wbbsSql = `
            SELECT
                BBSW.NO, BBSW.BBS_NO, BBSW.WRITER, BBSW.CONTENT,
                to_char(BBSW.REGDATE,'yyyy-mm-dd hh24:mi:ss') AS REGDATE_FORMATTED,
                BBSW.WCOUNT, BBSW.OK, BBSW.PARENT_NO, BBSW.DEPTH,
                BBSW.GROUP_ID, BBSW.ORDER_IN_GROUP, BBSW.GOOD, BBSW.BAD,
                LEVEL AS HIERARCHY_LEVEL, -- 계층 레벨 (들여쓰기용)
                (SELECT VOTE_TYPE FROM BBSW_LIKES WHERE USER_ID = :userId AND COMMENT_NO = BBSW.NO) AS MY_VOTE_TYPE
            FROM BBSW
            START WITH PARENT_NO IS NULL AND BBS_NO = :bbs_no -- 최상위 댓글부터 시작
            CONNECT BY PRIOR NO = PARENT_NO AND BBS_NO = PRIOR BBS_NO -- 부모-자식 관계 정의
            ORDER SIBLINGS BY REGDATE ASC, NO ASC -- 형제 댓글들을 등록일자, 번호 순으로 정렬
        `;
        console.log(`[Info] /read: 댓글 조회 SQL (계층 쿼리): ${wbbsSql}`);
        const wbbsRows = await connection.execute(wbbsSql, { bbs_no: req.query.brdno, userId: userId });
        console.log(`[Info] /read: 댓글 ${wbbsRows.rows.length}개 조회됨.`);

        res.render('bbs/read', {bbs: retBBS, wbbs: wbbsRows.rows, loggedInUser: req.session.user});

    } catch (err) {
        console.error(`[Error] /read: 게시글/댓글 조회 중 오류 발생: ${err.message}`, err.stack);
        res.render('bbs/error', {errcode: 500});
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (e) { console.error(`[Error] /read: DB 연결 해제 중 오류: ${e.message}`, e.stack); }
        }
    }
});

router.post('/wsave', async function(req, res, next){
    const bbsno = req.body.bbsno; // 게시글 NO
    const parent_no = req.body.parent_no || null; // 대댓글이면 부모 댓글 NO, 아니면 null
    const wbrdmemo = req.body.wbrdmemo; // 댓글 내용
    const writer = req.session.user ? req.session.user.id : null; // 작성자 ID (세션에서)
    let code = 0;

    // 로그인 확인
    if (!writer) {
        code = 5; // errcode 5: 로그인 필요
        console.log(`[Error] /wsave: 로그인되지 않은 사용자 접근 시도. IP: ${req.ip}`);
        return res.render('bbs/error', {errcode : code});
    }

    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig);

        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.execute('ALTER SESSION SET NLS_DATE_FORMAT = \'YYYY-MM-DD HH24:MI:SS\'');

        // 1. 새로운 댓글의 NO를 Oracle 시퀀스에서 미리 얻기
        const noResult = await connection.execute("SELECT bbsw_seq.nextval FROM DUAL");
        const newCommentNo = noResult.rows[0][0];
        console.log(`[Info] /wsave: 새로운 댓글 NO 할당: ${newCommentNo}`);

        let depth = 0;
        let group_id = newCommentNo; // 기본적으로 자신을 group_id로
        let order_in_group = 0; // ORA-01400 에러 해결을 위해 초기값 0 설정

        if (parent_no) { // 대댓글인 경우
            // 부모 댓글의 DEPTH와 GROUP_ID만 조회
            const parentResult = await connection.execute(
                "SELECT DEPTH, GROUP_ID FROM BBSW WHERE NO = :parent_no",
                { parent_no: parent_no }
            );

            if (parentResult.rows.length > 0) {
                const parentComment = parentResult.rows[0];
                depth = parentComment[0] + 1; // 부모보다 1 깊어짐
                group_id = parentComment[1]; // 부모의 group_id 상속

                // ORDER_IN_GROUP 계산: 동일 group_id 내에서 마지막 순서값 + 1
                const maxOrderResult = await connection.execute(
                    "SELECT NVL(MAX(ORDER_IN_GROUP), 0) FROM BBSW WHERE GROUP_ID = :group_id",
                    { group_id: group_id }
                );
                order_in_group = maxOrderResult.rows[0][0] + 1;

            } else {
                console.warn(`[Warning] /wsave: 부모 댓글 (NO: ${parent_no})를 찾을 수 없음. 최상위 댓글로 처리.`);
                // 부모를 찾지 못해도 기본값(최상위 댓글)으로 진행하며, order_in_group은 0으로 유지
            }
            console.log(`[Info] /wsave: 대댓글 (NO:${newCommentNo}) - DEPTH: ${depth}, GROUP_ID: ${group_id}, ORDER_IN_GROUP: ${order_in_group}`);
        } else { // 최상위 댓글인 경우
            // 최상위 댓글의 경우 ORDER_IN_GROUP은 보통 0 또는 1로 시작
            // 여기서는 0으로 유지
            console.log(`[Info] /wsave: 최상위 댓글 (NO:${newCommentNo}) - DEPTH: ${depth}, GROUP_ID: ${group_id}, ORDER_IN_GROUP: ${order_in_group}`);
        }

        // 2. BBSW 테이블에 댓글 삽입
        const insertSql = `
            INSERT INTO BBSW (NO, BBS_NO, WRITER, CONTENT, REGDATE, PARENT_NO, DEPTH, GROUP_ID, OK, WCOUNT, GOOD, BAD, ORDER_IN_GROUP)
            VALUES (:no, :bbs_no, :writer, :content, SYSDATE, :parent_no, :depth, :group_id, 1, 0, 0, 0, :order_in_group)
        `;
        const binds = {
            no: newCommentNo,
            bbs_no: bbsno,
            writer: writer,
            content: wbrdmemo,
            parent_no: parent_no,
            depth: depth,
            group_id: group_id,
            order_in_group: order_in_group, // ORA-01400 해결! 이 값에 NULL이 아닌 유효한 값을 넣어줍니다.
        };
        const result = await connection.execute(insertSql, binds);
        console.log(`[Success] /wsave: 댓글 삽입 성공. Rows affected: ${result.rowsAffected}`);

        await connection.commit(); // 모든 작업이 성공하면 커밋
        res.redirect("/bbs/read?brdno=" + bbsno);

    } catch (err) {
        console.error(`[Error] /wsave: 댓글 저장 중 오류 발생: ${err.message}`, err.stack);
        if (connection) {
            try { await connection.rollback(); }
            catch (e) { console.error(`[Error] /wsave: Rollback failed: ${e.message}`, e.stack); }
        }
        res.render('bbs/error', {errcode : 500}); // 서버 오류
    } finally {
        if (connection) {
            try { await connection.close(); } // 연결 해제
            catch (e) { console.error(`[Error] /wsave: DB 연결 해제 중 오류: ${e.message}`, e.stack); }
        }
    }
});

router.get('/w_delete', async function(req, res, next) {
    const commentNo = req.query.commentNo;
    const bbsno = req.query.bbsno;
    const writer = req.session.user ? req.session.user.id : null;
    let code = 0;
    let connection;

    if (!writer) {
        code = 5; // 로그인 필요
        return res.render('bbs/error', { errcode: code });
    }

    try {
        connection = await oracledb.getConnection(dbconfig);
        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

        // 1. 해당 댓글의 정보 (writer) 조회
        const commentResult = await connection.execute(
            `SELECT WRITER FROM BBSW WHERE NO = :commentNo`,
            { commentNo: commentNo }
        );

        if (commentResult.rows.length === 0) {
            console.warn(`[Warning] /w_delete: 댓글 (NO: ${commentNo})을 찾을 수 없음.`);
            code = 404; // 댓글 없음
            return res.render('bbs/error', { errcode: code });
        }

        const commentWriter = commentResult.rows[0][0];

        // 2. 작성자 본인 확인
        if (commentWriter !== writer) {
            console.warn(`[Warning] /w_delete: 댓글 삭제 권한 없음. 요청자: ${writer}, 댓글 작성자: ${commentWriter}`);
            code = 403; // 권한 없음
            return res.render('bbs/error', { errcode: code });
        }

        // 3. 해당 댓글이 대댓글을 가지고 있는지 확인 (자식 댓글 존재 여부)
        const hasChildrenResult = await connection.execute(
            `SELECT COUNT(*) FROM BBSW WHERE PARENT_NO = :commentNo`,
            { commentNo: commentNo }
        );
        const hasChildren = hasChildrenResult.rows[0][0] > 0;

        let deleteSql;
        let deleteBinds;

        if (hasChildren) {
            // 자식 댓글이 있는 경우: OK (상태) 값을 0으로 업데이트 (삭제 표시)
            deleteSql = `UPDATE BBSW SET OK = 0, CONTENT = '삭제된 댓글입니다.' WHERE NO = :commentNo`;
            deleteBinds = { commentNo: commentNo };
            console.log(`[Info] /w_delete: 댓글 (NO: ${commentNo})에 자식 댓글이 있어 상태를 '삭제됨'으로 변경.`);
        } else {
            // 자식 댓글이 없는 경우: 실제 삭제
            deleteSql = `DELETE FROM BBSW WHERE NO = :commentNo`;
            deleteBinds = { commentNo: commentNo };
            console.log(`[Info] /w_delete: 댓글 (NO: ${commentNo})에 자식 댓글이 없어 물리적으로 삭제.`);

            // !!! ORDER_IN_GROUP 밀어내기 로직은 더 이상 필요 없습니다. 제거 !!!
        }
        
        await connection.execute(deleteSql, deleteBinds);
        await connection.commit();

        res.redirect(`/bbs/read?brdno=${bbsno}`);

    } catch (err) {
        console.error(`[Error] /w_delete: 댓글 삭제 중 오류 발생: ${err.message}`, err.stack);
        if (connection) {
            try { await connection.rollback(); }
            catch (e) { console.error(`[Error] /w_delete: Rollback failed: ${e.message}`, e.stack); }
        }
        res.render('bbs/error', { errcode: 500 });
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (e) { console.error(`[Error] /w_delete: DB 연결 해제 중 오류: ${e.message}`, e.stack); }
        }
    }
});

router.get('/find_id', function(req, res, next) {
    res.render('bbs/find_id');
});

router.post('/find_id', async function(req, res, next) { // async 추가
    const { name } = req.body; // 폼에서 전송된 이름

    if (!name || name.trim() === '') {
        return res.render('bbs/forgot_id', {
            message: "이름을 입력해주세요.",
            messageType: 'error'
        });
    }

    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig);
        // 이름으로 아이디를 조회하는 SQL
        const sql = "SELECT ID FROM LOGIN WHERE NAME = :name";
        const result = await connection.execute(sql, { name });

        if (result.rows.length > 0) {
            const userId = result.rows[0][0]; // 찾은 아이디
            res.render('bbs/forgot_id', {
                message: `회원님의 아이디는 '${userId}' 입니다.`,
                messageType: 'success'
            });
        } else {
            res.render('bbs/forgot_id', {
                message: "입력하신 이름과 일치하는 아이디를 찾을 수 없습니다.",
                messageType: 'error'
            });
        }
    } catch (err) {
        console.error("아이디 찾기 처리 중 오류:", err);
        res.render('bbs/forgot_id', {
            message: "아이디 찾기 중 오류가 발생했습니다. 다시 시도해주세요.",
            messageType: 'error'
        });
    } finally {
        if (connection) {
            try { await connection.close(); } catch (e) { console.error(e); }
        }
    }
});

router.get('/reset_password_request', function(req, res, next) {
    res.render('bbs/reset_password_request');
});

router.post('/reset_password_request', async function(req, res, next) { // async 추가
    var id = req.body.id;
    var email = req.body.email;
    var code = 0;

    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig);

        var sql = "SELECT ID FROM LOGIN WHERE ID = :id AND EMAIL = :email AND OK = 1"; // 활성화된 계정만 조회
        const result = await connection.execute(sql, { id: id, email: email });

        if (result.rows.length > 0) {
            // ID와 이메일이 일치하면 비밀번호 재설정 페이지로 리다이렉트
            res.redirect('/bbs/reset_password?id=' + id);
        } else {
            code = 1; // ID 또는 이메일 불일치
            res.render('bbs/reset_password_request', { errcode: code });
        }
    } catch (err) {
        console.error("Error checking ID and email:", err);
        res.render('bbs/error', { errcode: 500 });
    } finally {
        if (connection) {
            try { await connection.close(); } catch (e) { console.error(e); }
        }
    }
});

router.get('/reset_password', function(req, res, next) {
    var id = req.query.id;
    if (!id) {
        return res.redirect('/bbs/reset_password_request'); // ID 없으면 요청 페이지로
    }
    res.render('bbs/reset_password', { id: id, errcode: 0 });
});

router.post('/reset_password', async function(req, res, next) { // async 추가
    var id = req.body.id;
    var newPw = req.body.new_password;
    var confirmPw = req.body.confirm_password;
    var code = 0;

    if (newPw !== confirmPw) {
        code = 1; // 비밀번호 불일치
        return res.render('bbs/reset_password', { id: id, errcode: code });
    }
    if (!newPw || newPw.trim() === '') {
        code = 2; // 비밀번호 공백
        return res.render('bbs/reset_password', { id: id, errcode: code });
    }

    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig);
        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

        // 4. 아이디, 이름, 이메일 주소 일치 여부 확인 (이전 find_id와 reset_password_request에서 이미 확인했으므로 여기서는 생략 가능하지만, 보안상 다시 확인하는 것도 좋음)
        // 여기서는 이미 id가 넘어왔으므로, 해당 id의 salt를 가져와 비밀번호를 업데이트합니다.
        const checkSql = "SELECT ID FROM LOGIN WHERE ID = :id AND OK = 1"; // 활성화된 계정만 조회
        const checkResult = await connection.execute(checkSql, { id });

        if (checkResult.rows.length === 0) {
            console.warn(`[Warning] 비밀번호 재설정: 입력 정보 불일치 - ID: ${id}`);
            code = 3; // 사용자 정보를 찾을 수 없음
            return res.render('bbs/reset_password', { id: id, errcode: code });
        }

        // 5. 새로운 비밀번호로 업데이트
        const salt = Math.round(new Date().valueOf() * Math.random()) + "";
        const hashPassword = crypto.createHash("sha512").update(newPw + salt).digest("base64");

        const updateSql = `UPDATE LOGIN SET PASSWORD = :hashPassword, SALT = :salt WHERE ID = :id`;
        const updateResult = await connection.execute(updateSql, { hashPassword, salt, id });

        if (updateResult.rowsAffected === 0) {
            throw new Error("비밀번호 업데이트에 실패했습니다. 데이터베이스 오류.");
        }

        await connection.commit();
        console.log(`[Success] 비밀번호 재설정 완료: 사용자 ${id}`);
        res.render('bbs/login', { message: "비밀번호가 성공적으로 재설정되었습니다. 새 비밀번호로 로그인해주세요.", errcode: 0 });

    } catch (err) {
        console.error("비밀번호 재설정 처리 중 오류:", err);
        if (connection) {
            try { await connection.rollback(); }
            catch (e) { console.error(e); }
        }
        res.render('bbs/error', {
            message: "비밀번호 재설정 중 오류가 발생했습니다. 다시 시도해주세요.",
            messageType: 'error'
        });
    } finally {
        if (connection) {
            try { await connection.close(); } catch (e) { console.error(e); }
        }
    }
});


router.post('/w_vote', async function(req, res, next) {
    const commentNo = req.query.commentNo;
    const voteType = parseInt(req.query.voteType); // 1: 좋아요, 0: 싫어요
    const bbsno = req.query.bbsno; // 게시글 번호
    const userId = req.session.user ? req.session.user.id : null;

    if (!userId) {
        return res.render('bbs/error', { errcode: 5 }); // 로그인 필요
    }

    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig);
        await connection.execute('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

        // 1. 사용자가 이미 해당 댓글에 투표했는지 확인
        const [existingVote] = await connection.execute(
            `SELECT VOTE_TYPE FROM BBSW_LIKES WHERE USER_ID = :userId AND COMMENT_NO = :commentNo`,
            { userId: userId, commentNo: commentNo }
        );

        let currentGood = 0;
        let currentBad = 0;
        const [currentVotes] = await connection.execute(
            `SELECT GOOD, BAD FROM BBSW WHERE NO = :commentNo`,
            { commentNo: commentNo }
        );
        if (currentVotes.rows.length > 0) {
            currentGood = currentVotes.rows[0][0];
            currentBad = currentVotes.rows[0][1];
        }

        if (existingVote.rows.length > 0) {
            // 2. 이미 투표한 경우: 변경 또는 취소
            const previousVoteType = existingVote.rows[0][0];

            if (previousVoteType === voteType) {
                // 2-1. 같은 종류의 투표를 다시 누른 경우: 투표 취소
                await connection.execute(
                    `DELETE FROM BBSW_LIKES WHERE USER_ID = :userId AND COMMENT_NO = :commentNo`,
                    { userId: userId, commentNo: commentNo }
                );
                if (voteType === 1) { // 좋아요 취소
                    await connection.execute(`UPDATE BBSW SET GOOD = GOOD - 1 WHERE NO = :commentNo`, { commentNo: commentNo });
                } else { // 싫어요 취소
                    await connection.execute(`UPDATE BBSW SET BAD = BAD - 1 WHERE NO = :commentNo`, { commentNo: commentNo });
                }
                console.log(`[Info] 투표 취소: Comment ${commentNo}, User ${userId}, Type ${voteType}`);
            } else {
                // 2-2. 다른 종류의 투표를 누른 경우: 투표 변경 (기존 투표 취소 후 새 투표 등록)
                await connection.execute(
                    `UPDATE BBSW_LIKES SET VOTE_TYPE = :voteType WHERE USER_ID = :userId AND COMMENT_NO = :commentNo`,
                    { voteType: voteType, userId: userId, commentNo: commentNo }
                );
                if (voteType === 1) { // 싫어요 -> 좋아요
                    await connection.execute(`UPDATE BBSW SET BAD = BAD - 1, GOOD = GOOD + 1 WHERE NO = :commentNo`, { commentNo: commentNo });
                } else { // 좋아요 -> 싫어요
                    await connection.execute(`UPDATE BBSW SET GOOD = GOOD - 1, BAD = BAD + 1 WHERE NO = :commentNo`, { commentNo: commentNo });
                }
                console.log(`[Info] 투표 변경: Comment ${commentNo}, User ${userId}, From ${previousVoteType} To ${voteType}`);
            }
        } else {
            // 3. 처음 투표하는 경우: 투표 기록 추가
            await connection.execute(
                `INSERT INTO BBSW_LIKES (USER_ID, COMMENT_NO, VOTE_TYPE) VALUES (:userId, :commentNo, :voteType)`,
                { userId: userId, commentNo: commentNo, voteType: voteType }
            );
            if (voteType === 1) { // 좋아요
                await connection.execute(`UPDATE BBSW SET GOOD = GOOD + 1 WHERE NO = :commentNo`, { commentNo: commentNo });
            } else { // 싫어요
                await connection.execute(`UPDATE BBSW SET BAD = BAD + 1 WHERE NO = :commentNo`, { commentNo: commentNo });
            }
            console.log(`[Info] 새 투표: Comment ${commentNo}, User ${userId}, Type ${voteType}`);
        }

        await connection.commit();
        res.redirect(`/bbs/read?brdno=${bbsno}`);

    } catch (err) {
        console.error(`[Error] 투표 처리 중 오류 발생: ${err.message}`, err.stack);
        if (connection) {
            try { await connection.rollback(); }
            catch (e) { console.error(`[Error] Rollback failed: ${e.message}`, e.stack); }
        }
        res.render('bbs/error', { errcode: 500 });
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (e) { console.error(`[Error] DB 연결 해제 중 오류: ${e.message}`, e.stack); }
        }
    }
});

router.get('/update', async function(req,res,next) { // async 추가
    if(req.session.user)
    {
        let connection;
        try {
            connection = await oracledb.getConnection(dbconfig);
            var sql = "SELECT NO, TITLE, CONTENT, WRITER, FILE_PATH, ORIGINAL_FILE_NAME FROM BBS WHERE NO="+req.query.brdno;
            const rows = await connection.execute(sql); // await 사용
            
            res.render('bbs/update', {data:rows});
        } catch (err) {
            console.error("err : "+ err);
            res.render('bbs/error', { errcode: 500 });
        } finally {
            if (connection) {
                try { await connection.close(); }
                catch (e) { console.error(e); }
            }
        }
    }
    else
    {
        res.redirect('/bbs/list');
    }
});
router.post('/delete', async function(req,res,next){ // async 추가
    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig);
        var sql = "UPDATE BBS SET OK=0" +
                " WHERE NO=" + req.body.brdno;
        console.log("row : "+ req.body.brdno);
 
        await connection.execute(sql, { autoCommit: true }); // await 사용
 
        res.redirect('/bbs/list');
    } catch (err) {
        console.error("err : "+ err);
        res.render('bbs/error', { errcode: 500 });
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (e) { console.error(e); }
        }
    }
});
// 게시글 수정 (파일 업로드 처리 추가)
router.post('/updatesave', upload.single('userfile'), async function(req, res, next) { // async 추가
    const { brdno, brdtitle, brdmemo, brdwriter, existing_file_path } = req.body;
    let code = 0;
    let connection;

    // 서버 측 유효성 검사
    if (!brdtitle || brdtitle.trim() === '') {
        code = 7; // 에러 코드 7: 제목 필수
        return res.render('bbs/error', { errcode: code, message: "제목은 필수 입력 사항입니다." });
    }
    if (!brdmemo || brdmemo.trim() === '') {
        code = 8; // 에러 코드 8: 내용 필수
        return res.render('bbs/error', { errcode: code, message: "내용은 필수 입력 사항입니다." });
    }

    try {
        connection = await oracledb.getConnection(dbconfig);

        let filePath = existing_file_path || null; // 기존 파일 경로 유지
        let originalFileName = null; // 기존 파일 이름 유지

        // 파일 업로드 유효성 검사 오류 처리
        if (req.fileValidationError) {
            if (connection) connection.release();
            return res.render('bbs/error', { errcode: 400, message: req.fileValidationError.message });
        }

        // 새로운 파일이 업로드된 경우
        if (req.file) {
            filePath = '/uploads/' + req.file.filename;
            originalFileName = req.file.originalname;

            // 기존 파일이 있었다면 삭제
            if (existing_file_path) {
                const oldFilePath = path.join(UPLOAD_DIR, path.basename(existing_file_path));
                fs.unlink(oldFilePath, (unlinkErr) => {
                    if (unlinkErr) console.error("Error deleting old file:", unlinkErr);
                    else console.log(`Old file ${oldFilePath} deleted.`);
                });
            }
        } else if (req.body.delete_file === 'on') {
            // 파일 삭제 체크박스가 선택된 경우
            if (existing_file_path) {
                const oldFilePath = path.join(UPLOAD_DIR, path.basename(existing_file_path));
                fs.unlink(oldFilePath, (unlinkErr) => {
                    if (unlinkErr) console.error("Error deleting old file:", unlinkErr);
                    else console.log(`Old file ${oldFilePath} deleted by user request.`);
                });
            }
            filePath = null; // DB에서 파일 경로 제거
            originalFileName = null;
        }

        const sql = `
            UPDATE BBS
            SET TITLE = :title,
                CONTENT = :content,
                WRITER = :writer,
                FILE_PATH = :filePath,
                ORIGINAL_FILE_NAME = :originalFileName
            WHERE NO = :brdno
        `;

        const binds = {
            title: brdtitle,
            content: brdmemo,
            writer: brdwriter,
            filePath: filePath,
            originalFileName: originalFileName,
            brdno: brdno
        };

        const result = await connection.execute(sql, binds, { autoCommit: true }); // Multer 업로드 후에는 autoCommit 유지해도 무방 (단일 작업)
        console.log("Rows affected:", result.rowsAffected);
        res.redirect('/bbs/list');

    } catch (err) {
        console.error("DB execute error:", err);
        // 오류 발생 시 새로 업로드된 파일 삭제 (있을 경우)
        if (req.file) {
            fs.unlink(req.file.path, (unlinkErr) => {
                if (unlinkErr) console.error("Error deleting uploaded file:", unlinkErr);
            });
        }
        res.render('bbs/error', { errcode: 500 });
    } finally {
        if (connection) {
            try { connection.release(); }
            catch (e) { console.error(e); }
        }
    }
});

router.get('/search', async function(req,res,next){ // async 추가

    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig);
        var sql;
        if(req.query.choice=="TITLE_CONTENT"){
            sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK" + 
            " FROM BBS WHERE TITLE LIKE '%" + req.query.search + "%' OR CONTENT LIKE '%"+     req.query.search +
            "%' ORDER BY NO DESC";
        }
        else{
            sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK" + 
            " FROM BBS WHERE " + req.query.choice + " LIKE '%" + req.query.search + "%' ORDER BY NO DESC";
        }
        console.log("sql : " + sql);
        const rows = await connection.execute(sql); // await 사용

        res.render('bbs/list', {data:rows});
    } catch (err) {
        console.error("err : "+ err);
        res.render('bbs/error', { errcode: 500 });
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (e) { console.error(e); }
        }
    }
});

module.exports = router;