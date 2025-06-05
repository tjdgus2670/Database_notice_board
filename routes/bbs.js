var express = require('express');
var router = express.Router();
var oracledb = require('oracledb');
var crypto = require('crypto');
const session = require('express-session');
const migrateUnhashedPasswords = require('../migrate-password');
var multer = require('multer'); // multer 모듈 추가
var path = require('path'); // 파일 경로 처리를 위해 path 모듈 추가
const fs = require('fs'); // 파일 삭제를 위해 fs 모듈 추가

oracledb.autoCommit = true;

var dbconfig = {
    user : "TEST_USER",
    password : "1234",
    connectString : "localhost/XEPDB1"
};

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
    if( id == "" || pw1 == "" || name == "")
    {
        code = 2;
        res.render('bbs/error', {errcode : code});
        return;
    }

    var salt = Math.round(new Date().valueOf()*Math.random()) + "";
    var hashPassword = crypto.createHash("sha512").update(pw1+salt).digest("base64");

    console.log("salt : "+salt);
    console.log("hashPassword : "+hashPassword);

    var sql = "INSERT INTO LOGIN(ID, PASSWORD, NAME, EMAIL, SALT, OK) " + "VALUES('" + id + "','" + hashPassword + "','" + name + "','" + email + "','" + salt + "', 1)";    
    
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
                  " NAME = '" + name + "', EMAIL = '" + email + "' WHERE ID = '" + id + "'";

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
            try { await connection.close(); }
            catch (e) { console.error(e); }
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
            var sql = "SELECT COUNT(*) FROM BBS WHERE OK = 1"; // OK = 1 인 활성화된 게시글만 카운트
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
        return res.render('bbs/error', { errcode: code, message: "제목은 필수 입력 사항입니다." });
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
                            "VALUES(bbs_seq.nextval, :title, :content, :writer, SYSDATE, :filePath, :originalFileName, :ok)"; // OK 컬럼 추가
        
        const binds = {
            title: brdtitle,
            content: brdmemo,
            writer: brdwriter,
            filePath: filePath,
            originalFileName: originalFileName,
            ok: 1 // 새 게시글은 기본적으로 활성화 (OK=1)
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
            console.log("rows : "+JSON.stringify(rows));

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
            // SQL 쿼리 수정: OK = 1 조건 추가
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
        var sql = `
            SELECT
                BBSW.NO, BBSW.BBS_NO, BBSW.WRITER, BBSW.CONTENT, to_char(BBSW.REGDATE,'yyyy-mm-dd hh24:mi:ss') AS REGDATE_FORMATTED,
                BBSW.WCOUNT, BBSW.OK, BBSW.PARENT_NO, BBSW.DEPTH, BBSW.GROUP_ID, BBSW.ORDER_IN_GROUP, BBSW.GOOD, BBSW.BAD,
                (SELECT VOTE_TYPE FROM BBSW_LIKES WHERE USER_ID = :userId AND COMMENT_NO = BBSW.NO) AS MY_VOTE_TYPE
            FROM BBSW
            WHERE BBS_NO = :bbs_no AND BBSW.OK = 1 -- 활성화된 댓글만 가져오도록 추가
            ORDER BY BBSW.GROUP_ID ASC, BBSW.REGDATE ASC, BBSW.ORDER_IN_GROUP ASC
        `; // [cite: 252, 253, 254]
        console.log(`[Info] /read: 댓글 조회 SQL: ${sql}`); // [cite: 254]
        const wbbsRows = await connection.execute(sql, { bbs_no: req.query.brdno, userId: userId }); // [cite: 254]
        console.log(`[Info] /read: 댓글 ${wbbsRows.rows.length}개 조회됨.`); // [cite: 255]

        res.render('bbs/read', {bbs: retBBS, wbbs: wbbsRows.rows, loggedInUser: req.session.user}); // [cite: 255, 256]

    } catch (err) {
        console.error(`[Error] /read: 게시글/댓글 조회 중 오류 발생: ${err.message}`, err.stack); // [cite: 256]
        res.render('bbs/error', {errcode: 500}); // [cite: 257]
    } finally {
        if (connection) {
            try { await connection.close(); } // [cite: 257]
            catch (e) { console.error(`[Error] /read: DB 연결 해제 중 오류: ${e.message}`, e.stack); } // [cite: 258, 259]
        }
    }
});

router.post('/wsave', async function(req, res, next){
    const bbsno = req.body.bbsno; // 게시글 NO [cite: 260]
    const parent_no = req.body.parent_no || null; // 대댓글이면 부모 댓글 NO, 아니면 null [cite: 260]
    const wbrdmemo = req.body.wbrdmemo; // 댓글 내용 [cite: 260]
    const writer = req.session.user ? req.session.user.id : null; // 작성자 ID (세션에서) [cite: 260]
    let code = 0;

    // 로그인 확인 [cite: 260]
    if (!writer) {
        code = 5; // errcode 5: 로그인 필요 [cite: 260]
        console.log(`[Error] /wsave: 로그인되지 않은 사용자 접근 시도. IP: ${req.ip}`); // [cite: 261]
        return res.render('bbs/error', {errcode : code}); // [cite: 261]
    }

    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig); // [cite: 261]

        let depth = 0;
        let group_id;
        let order_in_group;

        // 1. 새로운 댓글의 NO를 Oracle 시퀀스에서 미리 얻기 [cite: 261, 262]
        // 이는 GROUP_ID를 자신으로 설정해야 하는 최상위 댓글의 경우에 필요합니다.
        const noResult = await connection.execute("SELECT bbsw_seq.nextval FROM DUAL"); // [cite: 262]
        const newCommentNo = noResult.rows[0][0]; // [cite: 262]
        console.log(`[Info] /wsave: 새로운 댓글 NO 할당: ${newCommentNo}`); // [cite: 262]

        if (parent_no) { // **대댓글인 경우** [cite: 263]
            console.log(`[Info] /wsave: 대댓글 작성 시도 (부모 NO: ${parent_no})`); // [cite: 263]
            // 부모 댓글의 DEPTH와 GROUP_ID를 조회 [cite: 264]
            const parentResult = await connection.execute( // [cite: 264]
                "SELECT DEPTH, GROUP_ID FROM BBSW WHERE NO = :parent_no",
                { parent_no: parent_no }
            );
            if (parentResult.rows.length > 0) { // [cite: 265]
                const parentDepth = parentResult.rows[0][0]; // [cite: 265]
                const parentGroupId = parentResult.rows[0][1]; // [cite: 266]

                depth = parentDepth + 1; // [cite: 266]
                group_id = parentGroupId; // 부모의 group_id 상속 [cite: 266, 267]

                // ORDER_IN_GROUP 계산: 동일한 group_id 내에서, 부모가 동일한 댓글들 중 가장 마지막에 추가
                // (이는 read 쿼리의 REGDATE ASC 정렬과 함께 정확한 순서를 보장)
                const maxOrderInGroupResult = await connection.execute( // [cite: 268]
                    `SELECT NVL(MAX(ORDER_IN_GROUP), 0) FROM BBSW WHERE GROUP_ID = :group_id AND PARENT_NO = :parent_no`,
                    { group_id: group_id, parent_no: parent_no }
                );
                order_in_group = maxOrderInGroupResult.rows[0][0] + 1; // [cite: 269]
                console.log(`[Info] /wsave: 대댓글 (NO:${newCommentNo}) - DEPTH: ${depth}, GROUP_ID: ${group_id}, ORDER_IN_GROUP: ${order_in_group}`); // [cite: 269]
            } else {
                // 부모 댓글을 찾을 수 없는 경우 (예외 상황), 최상위 댓글로 간주하고 경고 [cite: 270]
                console.warn(`[Warning] /wsave: 부모 댓글 (NO: ${parent_no})를 찾을 수 없음. 최상위 댓글로 처리.`); // [cite: 270]
                parent_no = null; // 최상위 댓글로 간주 [cite: 271]
                depth = 0; // [cite: 271]
                group_id = newCommentNo; // 자신의 NO를 group_id로 [cite: 272]

                // 최상위 댓글의 order_in_group은 해당 게시글 내 최상위 댓글 중 가장 마지막에 위치 [cite: 272]
                const maxTopOrderResult = await connection.execute( // [cite: 272]
                    `SELECT NVL(MAX(ORDER_IN_GROUP), 0) FROM BBSW WHERE BBS_NO = :bbs_no AND PARENT_NO IS NULL`,
                    { bbs_no: bbsno }
                );
                order_in_group = maxTopOrderResult.rows[0][0] + 1; // [cite: 274]
                console.log(`[Info] /wsave: 최상위 댓글 (NO:${newCommentNo}) - DEPTH: ${depth}, GROUP_ID: ${group_id}, ORDER_IN_GROUP: ${order_in_group}`); // [cite: 274]
            }
        } else { // **최상위 댓글인 경우** [cite: 275]
            console.log(`[Info] /wsave: 최상위 댓글 작성 시도 (게시글 NO: ${bbsno})`); // [cite: 275]
            depth = 0; // [cite: 276]
            group_id = newCommentNo; // 자신의 NO를 group_id로 [cite: 276]

            // 최상위 댓글의 ORDER_IN_GROUP은 해당 게시글 내 최상위 댓글 중 가장 마지막에 추가 [cite: 276]
            const maxTopOrderResult = await connection.execute( // [cite: 276]
                `SELECT NVL(MAX(ORDER_IN_GROUP), 0) FROM BBSW WHERE BBS_NO = :bbs_no AND PARENT_NO IS NULL`,
                { bbs_no: bbsno }
            );
            order_in_group = maxTopOrderResult.rows[0][0] + 1; // [cite: 278]
            console.log(`[Info] /wsave: 최상위 댓글 (NO:${newCommentNo}) - DEPTH: ${depth}, GROUP_ID: ${group_id}, ORDER_IN_GROUP: ${order_in_group}`); // [cite: 278, 279]
        }

        // 2. BBSW 테이블에 댓글 삽입 [cite: 279]
        const insertSql = `
            INSERT INTO BBSW (NO, BBS_NO, WRITER, CONTENT, REGDATE, PARENT_NO, DEPTH, GROUP_ID, ORDER_IN_GROUP, OK, WCOUNT, GOOD, BAD)
            VALUES (:no, :bbs_no, :writer, :content, SYSDATE, :parent_no, :depth, :group_id, :order_in_group, 1, 0, 0, 0)
        `; // [cite: 279]
        const binds = {
            no: newCommentNo,
            bbs_no: bbsno,
            writer: writer,
            content: wbrdmemo,
            parent_no: parent_no,
            depth: depth,
            group_id: group_id,
            order_in_group: order_in_group
        }; // [cite: 280, 281]
        const result = await connection.execute(insertSql, binds); // [cite: 282]
        console.log(`[Success] /wsave: 댓글 삽입 성공. Rows affected: ${result.rowsAffected}`); // [cite: 282]

        res.redirect("/bbs/read?brdno=" + bbsno); // [cite: 282]
    } catch (err) {
        console.error(`[Error] /wsave: 댓글 저장 중 오류 발생: ${err.message}`, err.stack); // [cite: 283]
        res.render('bbs/error', {errcode : 500}); // 서버 오류 [cite: 284]
    } finally {
        if (connection) {
            try { await connection.close(); } // [cite: 284]
            catch (e) { console.error(`[Error] /wsave: DB 연결 해제 중 오류: ${e.message}`, e.stack); } // [cite: 285, 286]
        }
    }
});


router.get('/w_delete', async function(req, res, next){
    const commentNo = req.query.commentNo; // 삭제할 댓글의 NO (read.ejs에서 넘어옴)
    const bbsno = req.query.bbsno;       // 삭제 후 돌아갈 게시글의 NO (read.ejs에서 넘어옴)

    console.log(`[Info] /w_delete: 댓글 삭제 요청 (댓글 NO: ${commentNo}, 게시글 NO: ${bbsno})`);

    // 로그인 여부 확인
    if (!req.session.user) {
        console.warn(`[Warning] /w_delete: 로그인되지 않은 사용자 댓글 삭제 시도. IP: ${req.ip}`);
        return res.render('bbs/error', { errcode: 5 }); // errcode 5: 로그인 필요
    }

    let connection;
    try {
        connection = await oracledb.getConnection(dbconfig);

        // 1. 댓글 작성자 확인 (권한 확인)
        const checkWriterSql = `SELECT WRITER FROM BBSW WHERE NO = :commentNo`;
        const checkResult = await connection.execute(checkWriterSql, { commentNo: commentNo });

        if (checkResult.rows.length === 0) {
            console.warn(`[Warning] /w_delete: 댓글 (NO: ${commentNo})을 찾을 수 없음.`);
            return res.render('bbs/error', { errcode: 404 }); // errcode 404: 댓글 없음
        }

        const commentWriter = checkResult.rows[0][0];
        if (commentWriter !== req.session.user.id) {
            console.warn(`[Warning] /w_delete: 권한 없는 사용자 댓글 삭제 시도. 사용자: ${req.session.user.id}, 댓글 작성자: ${commentWriter}`);
            return res.render('bbs/error', { errcode: 403 }); // errcode 403: 권한 없음
        }

        // 2. 논리적 삭제: OK 값을 0으로 업데이트
        const updateSql = `UPDATE BBSW SET OK = 0 WHERE NO = :commentNo`;
        const result = await connection.execute(updateSql, { commentNo: commentNo });

        if (result.rowsAffected > 0) {
            console.log(`[Success] /w_delete: 댓글 (NO: ${commentNo}) 논리적으로 삭제됨. (OK=0)`);
        } else {
            console.warn(`[Warning] /w_delete: 댓글 (NO: ${commentNo}) 논리적 삭제 실패. 영향을 받은 행 없음.`);
        }
        
        // 댓글 삭제 후 게시글 페이지로 리디렉션
        res.redirect(`/bbs/read?brdno=${bbsno}`);

    } catch (err) {
        console.error(`[Error] /w_delete: 댓글 삭제 중 오류 발생: ${err.message}`, err.stack);
        res.render('bbs/error', { errcode: 500 }); // errcode 500: 서버 오류
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (e) { console.error(`[Error] /w_delete: DB 연결 해제 중 오류: ${e.message}`, e.stack); }
        }
    }
});

router.get('/find_id', function(req, res, next) {
    res.render('bbs/forgot_id', { message: null, messageType: null });
});

// POST /bbs/find_id - 이름으로 아이디 찾기 처리
router.post('/find_id', async function(req, res, next) {
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

// GET /bbs/reset_password_request - 비밀번호 재설정 요청 폼 렌더링
// 이 라우트는 아이디/이름/이메일 입력 폼을 보여줍니다.
router.get('/reset_password_request', function(req, res, next) {
    res.render('bbs/reset_password_request', { message: null, messageType: null });
});

// POST /bbs/reset_password - 아이디/이름/이메일 일치 확인 후 비밀번호 재설정
router.post('/reset_password', async function(req, res, next) {
    const { id, name, email, newPassword, confirmPassword } = req.body;
    let connection;

    // 1. 필수 입력값 검사
    if (!id || !name || !email || !newPassword || !confirmPassword ||
        id.trim() === '' || name.trim() === '' || email.trim() === '' ||
        newPassword.trim() === '' || confirmPassword.trim() === '') {
        return res.render('bbs/reset_password_request', {
            message: "모든 필드를 입력해주세요.",
            messageType: 'error'
        });
    }

    // 2. 새 비밀번호와 확인 비밀번호 일치 여부 검사
    if (newPassword !== confirmPassword) {
        return res.render('bbs/reset_password_request', {
            message: "새 비밀번호와 확인 비밀번호가 일치하지 않습니다.",
            messageType: 'error'
        });
    }

    // 3. 비밀번호 길이 검사 (예시: 최소 6자)
    if (newPassword.length < 6) {
        return res.render('bbs/reset_password_request', {
            message: "새 비밀번호는 최소 6자 이상이어야 합니다.",
            messageType: 'error'
        });
    }

    try {
        connection = await oracledb.getConnection(dbconfig);

        // 4. 아이디, 이름, 이메일 주소 일치 여부 확인
        const checkSql = "SELECT ID FROM LOGIN WHERE ID = :id AND NAME = :name AND EMAIL = :email";
        const checkResult = await connection.execute(checkSql, { id, name, email });

        if (checkResult.rows.length === 0) {
            console.warn(`[Warning] 비밀번호 재설정: 입력 정보 불일치 - ID: ${id}, Name: ${name}, Email: ${email}`);
            return res.render('bbs/reset_password_request', {
                message: "입력하신 정보와 일치하는 계정을 찾을 수 없습니다.",
                messageType: 'error'
            });
        }

        // 5. 새로운 비밀번호로 업데이트
        const salt = Math.round(new Date().valueOf() * Math.random()) + "";
        const hashPassword = crypto.createHash("sha512").update(newPassword + salt).digest("base64");

        const updateSql = `UPDATE LOGIN SET PASSWORD = :hashPassword, SALT = :salt WHERE ID = :id`;
        const updateResult = await connection.execute(updateSql, { hashPassword, salt, id });

        if (updateResult.rowsAffected === 0) {
            throw new Error("비밀번호 업데이트에 실패했습니다. 데이터베이스 오류.");
        }

        console.log(`[Success] 비밀번호 재설정 완료: 사용자 ${id}`);
        // 비밀번호 재설정 성공 시 로그인 페이지로 리다이렉트
        res.redirect('/bbs/login?message=' + encodeURIComponent("비밀번호가 성공적으로 재설정되었습니다. 새 비밀번호로 로그인해주세요.") + '&messageType=success');

    } catch (err) {
        console.error("비밀번호 재설정 처리 중 오류:", err);
        res.render('bbs/reset_password_request', {
            message: "비밀번호 재설정 중 오류가 발생했습니다. 다시 시도해주세요.",
            messageType: 'error'
        });
    } finally {
        if (connection) {
            try { await connection.close(); } catch (e) { console.error(e); }
        }
    }
});


router.get('/w_vote', async function(req, res, next) {
    const commentNo = req.query.commentNo;
    const voteType = parseInt(req.query.voteType); // 1: 좋아요, 0: 싫어요
    const bbsno = req.query.bbsno; // 좋아요/싫어요 후 돌아갈 게시글의 NO

    if (!req.session.user) {
        console.warn(`[Warning] /w_vote: 로그인되지 않은 사용자 투표 시도. IP: ${req.ip}`);
        return res.render('bbs/error', { errcode: 5 }); // errcode 5: 로그인 필요
    }

    const userId = req.session.user.id;
    let connection;

    try {
        connection = await oracledb.getConnection(dbconfig);

        // 1. 이미 투표했는지 확인
        const checkVoteSql = `SELECT VOTE_TYPE FROM BBSW_LIKES WHERE USER_ID = :userId AND COMMENT_NO = :commentNo`;
        const checkResult = await connection.execute(checkVoteSql, { userId: userId, commentNo: commentNo });

        let updateSql = '';
        let message = '';

        if (checkResult.rows.length > 0) {
            // 이미 투표한 경우
            const existingVoteType = checkResult.rows[0][0];

            if (existingVoteType === voteType) {
                // 같은 종류의 투표를 다시 누른 경우 -> 투표 취소 (좋아요 -> 좋아요 다시 누르면 취소)
                const deleteVoteSql = `DELETE FROM BBSW_LIKES WHERE USER_ID = :userId AND COMMENT_NO = :commentNo`;
                await connection.execute(deleteVoteSql, { userId: userId, commentNo: commentNo });

                if (voteType === 1) { // 좋아요 취소
                    updateSql = `UPDATE BBSW SET GOOD = GOOD - 1 WHERE NO = :commentNo`;
                    message = '좋아요를 취소했습니다.';
                } else { // 싫어요 취소
                    updateSql = `UPDATE BBSW SET BAD = BAD - 1 WHERE NO = :commentNo`;
                    message = '싫어요를 취소했습니다.';
                }
                await connection.execute(updateSql, { commentNo: commentNo });
                console.log(`[Success] /w_vote: 댓글 (NO:${commentNo}) ${message} 사용자: ${userId}`);
            } else {
                // 다른 종류의 투표를 누른 경우 -> 투표 변경 (좋아요 -> 싫어요 또는 싫어요 -> 좋아요)
                const updateVoteSql = `UPDATE BBSW_LIKES SET VOTE_TYPE = :voteType, REGDATE = SYSDATE WHERE USER_ID = :userId AND COMMENT_NO = :commentNo`;
                await connection.execute(updateVoteSql, { voteType: voteType, userId: userId, commentNo: commentNo });

                if (voteType === 1) { // 싫어요 -> 좋아요
                    updateSql = `UPDATE BBSW SET BAD = BAD - 1, GOOD = GOOD + 1 WHERE NO = :commentNo`;
                    message = '싫어요를 좋아요로 변경했습니다.';
                } else { // 좋아요 -> 싫어요
                    updateSql = `UPDATE BBSW SET GOOD = GOOD - 1, BAD = BAD + 1 WHERE NO = :commentNo`;
                    message = '좋아요를 싫어요로 변경했습니다.';
                }
                await connection.execute(updateSql, { commentNo: commentNo });
                console.log(`[Success] /w_vote: 댓글 (NO:${commentNo}) ${message} 사용자: ${userId}`);
            }
        } else {
            // 처음 투표하는 경우
            const insertVoteSql = `INSERT INTO BBSW_LIKES (USER_ID, COMMENT_NO, VOTE_TYPE, REGDATE) VALUES (:userId, :commentNo, :voteType, SYSDATE)`;
            await connection.execute(insertVoteSql, { userId: userId, commentNo: commentNo, voteType: voteType });

            if (voteType === 1) { // 좋아요
                updateSql = `UPDATE BBSW SET GOOD = GOOD + 1 WHERE NO = :commentNo`;
                message = '좋아요를 등록했습니다.';
            } else { // 싫어요
                updateSql = `UPDATE BBSW SET BAD = BAD + 1 WHERE NO = :commentNo`;
                message = '싫어요를 등록했습니다.';
            }
            await connection.execute(updateSql, { commentNo: commentNo });
            console.log(`[Success] /w_vote: 댓글 (NO:${commentNo}) ${message} 사용자: ${userId}`);
        }

        res.redirect(`/bbs/read?brdno=${bbsno}`);

    } catch (err) {
        console.error(`[Error] /w_vote: 투표 처리 중 오류 발생: ${err.message}`, err.stack);
        res.render('bbs/error', { errcode: 500 });
    } finally {
        if (connection) {
            try { await connection.close(); }
            catch (e) { console.error(`[Error] /w_vote: DB 연결 해제 중 오류 : ${e.message}`, e.stack); }
        }
    }
});


router.get('/update',function(req,res,next) {
    oracledb.getConnection(dbconfig,function(err,connection){
        var sql = "SELECT NO, TITLE, CONTENT, WRITER, to_char(REGDATE,'yyyy-mm-dd') FROM BBS WHERE NO="+req.query.brdno;
 
        connection.execute(sql,function(err,rows){
            if(err) console.error("err : "+ err);
 
            res.render('bbs/updateform',rows);
            connection.release();
       });
    });
});

router.get('/delete', function(req,res,next){
    oracledb.getConnection(dbconfig,function(err,connection){
      var sql = "UPDATE BBS SET OK=0" +
                " WHERE NO=" + req.query.brdno;
      console.log("row : "+ req.query.brdno);
 
      connection.execute(sql,function(err,rows){
        if(err) console.error("err : "+ err);
 
        res.redirect('/bbs/list');
        connection.release();
      });
    });
});
    

router.post('/updatesave',function(req,res,next){
    oracledb.getConnection(dbconfig,function(err,connection){
        var sql = "";
        if(req.body.brdno){
            sql="UPDATE BBS"+
                  " SET TITLE= '" + req.body.brdtitle + "', CONTENT='" + req.body.brdmemo+"', WRITER='" + req.body.brdwriter+"' " 
                  + "WHERE NO=" + req.body.brdno;
        }
        console.log("sql : " + sql);
        connection.execute(sql,function(err,rows){
            if(err) console.error("err : "+ err);

            res.redirect('/bbs/list');
            connection.release();
        });
    });
});

router.get('/search', function(req, res, next) {

    oracledb.getConnection(dbconfig, function(err, connection) {
        if (err) {
            console.error("DB connection error for search:", err);
            return res.render('bbs/error', { errcode: 500 });
        }

        var sql;
        const searchChoice = req.query.choice;
        const searchTerm = req.query.search;

        if (!searchTerm || searchTerm.trim() === '') {
            // 검색어가 없는 경우 전체 목록으로 리디렉션하거나 오류 처리
            console.warn("[Warning] /search: 검색어가 비어있습니다. 전체 목록으로 리디렉션합니다.");
            connection.release();
            return res.redirect('/bbs/list');
        }

        // 모든 검색 쿼리에 OK = 1 조건 추가하여 활성화된 게시글만 검색되도록 함
        if (searchChoice === "TITLE_CONTENT") {
            sql = `SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK, COUNT, FILE_PATH, ORIGINAL_FILE_NAME
                   FROM BBS
                   WHERE (TITLE LIKE '%' || :searchTerm || '%' OR CONTENT LIKE '%' || :searchTerm || '%') AND OK = 1
                   ORDER BY NO DESC`;
        } else if (searchChoice === "TITLE" || searchChoice === "WRITER") {
            sql = `SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK, COUNT, FILE_PATH, ORIGINAL_FILE_NAME
                   FROM BBS
                   WHERE ${searchChoice} LIKE '%' || :searchTerm || '%' AND OK = 1
                   ORDER BY NO DESC`;
        } else {
            // 유효하지 않은 검색 조건 처리
            console.warn("[Warning] /search: 유효하지 않은 검색 조건입니다:", searchChoice);
            connection.release();
            return res.render('bbs/error', { errcode: 400, message: "유효하지 않은 검색 조건입니다." });
        }

        console.log("Search SQL:", sql);
        // 바인드 변수 사용
        connection.execute(sql, { searchTerm: searchTerm }, function(err, result) { // [cite: 177]
            if (err) {
                console.error("err : " + err); // [cite: 177]
                connection.release();
                return res.render('bbs/error', { errcode: 500 });
            }

            // list.ejs 템플릿이 요구하는 형식에 맞춰 데이터 전달
            // 검색 결과에는 페이지네이션이 적용되지 않을 수 있으므로,
            // 간단하게 totalRecords를 검색된 레코드 수로 설정
            // 실제 구현에서는 검색 결과에 대해서도 페이지네이션을 적용할 수 있습니다.
            const totalRecords = result.rows.length;
            const pageSize = totalRecords > 0 ? totalRecords : 1; // 0으로 나누는 오류 방지
            const totalPage = 1; // 검색 결과는 보통 한 페이지에 다 보여주므로 1로 설정
            const currentPage = 1;
            const firstPage = 1;
            const lastPage = 1;
            const stNum = 0;

            res.render('bbs/list', {
                data: result, // result.rows가 아님. result 객체 전체 전달
                currentPage: currentPage,
                totalRecords: totalRecords,
                pageSize: pageSize,
                totalPage: totalPage,
                blockSize: 5, // 필요에 따라 조정
                firstPage: firstPage,
                lastPage: lastPage,
                stNum: stNum,
                loggedInUser: req.session.user // 로그인 사용자 정보도 전달
            });
            connection.release();
        });
    });
});

module.exports = router;