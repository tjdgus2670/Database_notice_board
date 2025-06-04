var express = require('express');
var router = express.Router();
var oracledb = require('oracledb');
var crypto = require('crypto');
const session = require('express-session');
const migrateUnhashedPasswords = require('../migrate-password');

oracledb.autoCommit = true;

var dbconfig = {
  user : "TEST_USER",
  password : "1234",
  connectString : "localhost/XEPDB1"
};

router.get('/', function(req, res, next) {
  res.redirect('/bbs/list');
});

router.get('/login', function(req, res, next) {
  var code = 0;
  if(req.session.user)  code = 3;
  res.render('bbs/login', {errcode : code});
});

router.get('/logout', function(req, res, next) {
  
  if(req.session.user)  req.session.destroy();

  res.redirect('/bbs/list');  
});

router.get('/signup', function(req, res, next) {
  var code = 0;
  if( req.session.user )  code = 1;
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
        id         : id,
        authorized : true
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

          var sql = "SELECT COUNT(*) FROM BBS ";
          
          connection.execute(sql,function(err,count){
              if(err) console.error("err : " + err);
              var totalRecords=parseInt(count.rows);
              console.log("total Records is "+totalRecords);
              connection.release();
              resolve(totalRecords);
          });
      });
  });
}

router.get('/list',async function(req,res,next) {
  var stNum=0, totalRecords=0, totalPage=0, firstPage=0, lastPage=0, currentPage=1, blockSize=5, pageSize=5;

  countRecord().then(function(totalRecords) {
      if(req.query.currentPage!=undefined) currentPage=parseInt(req.query.currentPage);

      totalPage=Math.ceil(totalRecords/pageSize);

      firstPage = Math.max(1, currentPage - 2);
      lastPage  = Math.min(totalPage, currentPage + 2);
      stNum=(currentPage-1)*pageSize;

      oracledb.getConnection(dbconfig,function(err,connection){
      
          var sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK, COUNT" + 
                     " FROM BBS ORDER BY NO DESC OFFSET "+stNum+" ROWS FETCH NEXT "+pageSize+" ROWS ONLY";
      
          connection.execute(sql,function(err,rows){
              if(err) console.error("err : "+err);

              console.log(rows);
              res.render('bbs/list', {data:rows,currentPage:currentPage,totalRecords:totalRecords,pageSize:pageSize,
                                      totalPage:totalPage,blockSize:blockSize,firstPage:firstPage,lastPage:lastPage,
                                     stNum:stNum});
              connection.release();
          });
      });
  })         
});

router.get('/form',function(req,res,next){
  if(req.session.user)
       res.render('bbs/form', {id: req.session.user.id});
  else
    res.render('bbs/form', {id:0});
});

router.post('/save',function(req,res,next){
  oracledb.getConnection(dbconfig,function(err,connection){
      var sql = "";
 
      sql = "INSERT INTO BBS(NO, TITLE, CONTENT, WRITER, REGDATE) VALUES(bbs_seq.nextval,'"
          + req.body.brdtitle + "','" + req.body.brdmemo + "','" + req.body.brdwriter+"', sysdate)";
 
      console.log("sql : " + sql);
      connection.execute(sql,function(err,rows){

        if(err) console.error("err : "+ err);
        if(rows) res.redirect('/bbs/list');

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
          var sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK, COUNT FROM BBS "+
                    " WHERE NO = :brdno"; // 바인드 변수 사용
          
          connection.execute(sql, { brdno: brdno }, function(err,retBBS){ // 바인드 변수 전달
              if(err) {
                  console.error("err : " + err);
                  reject(err); // 에러 발생 시 reject
              } else {
                  connection.release();
                  resolve(retBBS);
              }
          });
      });
  });
}

router.get('/read', async function(req,res,next){ // async 추가
  console.log(`[Info] /read: 게시글 조회 요청 (NO: ${req.query.brdno})`);

  let connection;
  try {
      // 게시글 정보 조회 (기존 read_bbs 함수 사용)
      const retBBS = await read_bbs(req.query.brdno); // await 사용
      if (!retBBS || retBBS.rows.length === 0) {
          console.warn(`[Warning] /read: 게시글 (NO: ${req.query.brdno})을 찾을 수 없음.`);
          return res.render('bbs/error', { errcode: 404 }); // 게시글 없음
      }

      connection = await oracledb.getConnection(dbconfig);
      
      // 댓글 조회 쿼리 수정: GROUP_ID와 ORDER_IN_GROUP으로 정렬
      // PARENT_NO, DEPTH, GROUP_ID, ORDER_IN_GROUP, OK 컬럼도 조회에 포함
      var sql = `
          SELECT 
              NO, BBS_NO, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss') AS REGDATE_FORMATTED, 
              WCOUNT, OK, PARENT_NO, DEPTH, GROUP_ID, ORDER_IN_GROUP, GOOD, BAD
          FROM BBSW
          WHERE BBS_NO = :bbs_no
          ORDER BY GROUP_ID ASC, ORDER_IN_GROUP ASC
      `; 
      
      console.log(`[Info] /read: 댓글 조회 SQL: ${sql}`);
      const wbbsRows = await connection.execute(sql, { bbs_no: req.query.brdno }); 
      console.log(`[Info] /read: 댓글 ${wbbsRows.rows.length}개 조회됨.`);
      
      res.render('bbs/read', {bbs: retBBS, wbbs: wbbsRows.rows}); // .rows로 데이터 전달
      
  } catch (err) {
      console.error(`[Error] /read: 게시글/댓글 조회 중 오류 발생: ${err.message}`, err.stack);
      res.render('bbs/error', {errcode: 500}); // 에러 페이지 렌더링
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
      
      let depth = 0;
      let group_id;
      let order_in_group;

      // 1. 새로운 댓글의 NO를 Oracle 시퀀스에서 미리 얻기
      // 이는 GROUP_ID를 자신으로 설정해야 하는 최상위 댓글의 경우에 필요합니다.
      const noResult = await connection.execute("SELECT bbsw_seq.nextval FROM DUAL");
      const newCommentNo = noResult.rows[0][0];
      console.log(`[Info] /wsave: 새로운 댓글 NO 할당: ${newCommentNo}`);

      if (parent_no) { // **대댓글인 경우**
          console.log(`[Info] /wsave: 대댓글 작성 시도 (부모 NO: ${parent_no})`);
          // 부모 댓글의 DEPTH와 GROUP_ID를 조회
          const parentResult = await connection.execute(
              "SELECT DEPTH, GROUP_ID FROM BBSW WHERE NO = :parent_no",
              { parent_no: parent_no }
          );

          if (parentResult.rows.length > 0) {
              const parentDepth = parentResult.rows[0][0];
              const parentGroupId = parentResult.rows[0][1];

              depth = parentDepth + 1;
              group_id = parentGroupId; // 부모의 group_id 상속

              // ORDER_IN_GROUP 계산: 해당 그룹 내에서 가장 마지막에 추가
              // 동일한 group_id를 가지면서 parent_no가 이 댓글의 parent_no인 댓글들 중
              // 가장 큰 order_in_group을 찾아 +1 합니다.
              // 이 방식은 '대댓글은 항상 부모 댓글의 마지막 답글로 붙는다'는 시나리오에 적합합니다.
              const maxOrderInGroupResult = await connection.execute(
                  `SELECT NVL(MAX(ORDER_IN_GROUP), 0) FROM BBSW WHERE GROUP_ID = :group_id AND PARENT_NO = :parent_no`,
                  { group_id: group_id, parent_no: parent_no }
              );
              order_in_group = maxOrderInGroupResult.rows[0][0] + 1;
              console.log(`[Info] /wsave: 대댓글 (NO:${newCommentNo}) - DEPTH: ${depth}, GROUP_ID: ${group_id}, ORDER_IN_GROUP: ${order_in_group}`);

          } else {
              // 부모 댓글을 찾을 수 없는 경우 (예외 상황), 최상위 댓글로 간주하고 경고
              console.warn(`[Warning] /wsave: 부모 댓글 (NO: ${parent_no})를 찾을 수 없음. 최상위 댓글로 처리.`);
              parent_no = null; // 최상위 댓글로 간주
              depth = 0;
              group_id = newCommentNo; // 자신의 NO를 group_id로
              
              // 최상위 댓글의 order_in_group은 해당 게시글 내 최상위 댓글 중 가장 마지막에 위치
              const maxTopOrderResult = await connection.execute(
                  `SELECT NVL(MAX(ORDER_IN_GROUP), 0) FROM BBSW WHERE BBS_NO = :bbs_no AND PARENT_NO IS NULL`,
                  { bbs_no: bbsno }
              );
              order_in_group = maxTopOrderResult.rows[0][0] + 1;
              console.log(`[Info] /wsave: 최상위 댓글 (NO:${newCommentNo}) - DEPTH: ${depth}, GROUP_ID: ${group_id}, ORDER_IN_GROUP: ${order_in_group}`);
          }
      } else { // **최상위 댓글인 경우**
          console.log(`[Info] /wsave: 최상위 댓글 작성 시도 (게시글 NO: ${bbsno})`);
          depth = 0;
          group_id = newCommentNo; // 자신의 NO를 group_id로
          
          // 최상위 댓글의 ORDER_IN_GROUP은 해당 게시글 내 최상위 댓글 중 가장 마지막에 추가
          const maxTopOrderResult = await connection.execute(
              `SELECT NVL(MAX(ORDER_IN_GROUP), 0) FROM BBSW WHERE BBS_NO = :bbs_no AND PARENT_NO IS NULL`,
              { bbs_no: bbsno }
          );
          order_in_group = maxTopOrderResult.rows[0][0] + 1;
          console.log(`[Info] /wsave: 최상위 댓글 (NO:${newCommentNo}) - DEPTH: ${depth}, GROUP_ID: ${group_id}, ORDER_IN_GROUP: ${order_in_group}`);
      }

      // 2. BBSW 테이블에 댓글 삽입
      const insertSql = `
          INSERT INTO BBSW (NO, BBS_NO, WRITER, CONTENT, REGDATE, PARENT_NO, DEPTH, GROUP_ID, ORDER_IN_GROUP, OK, WCOUNT, GOOD, BAD)
          VALUES (:no, :bbs_no, :writer, :content, SYSDATE, :parent_no, :depth, :group_id, :order_in_group, 1, 0, 0, 0)
      `; // OK, WCOUNT, GOOD, BAD 초기값 설정
      const binds = {
          no: newCommentNo,
          bbs_no: bbsno,
          writer: writer,
          content: wbrdmemo,
          parent_no: parent_no,
          depth: depth,
          group_id: group_id,
          order_in_group: order_in_group
      };

      const result = await connection.execute(insertSql, binds);
      console.log(`[Success] /wsave: 댓글 삽입 성공. Rows affected: ${result.rowsAffected}`);

      res.redirect("/bbs/read?brdno=" + bbsno);

  } catch (err) {
      console.error(`[Error] /wsave: 댓글 저장 중 오류 발생: ${err.message}`, err.stack);
      res.render('bbs/error', {errcode : 500}); // 서버 오류
  } finally {
      if (connection) {
          try { await connection.close(); }
          catch (e) { console.error(`[Error] /wsave: DB 연결 해제 중 오류: ${e.message}`, e.stack); }
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

router.get('/search',function(req,res,next){

  oracledb.getConnection(dbconfig,function(err,connection){
      var sql;
      if(req.query.choice=="TITLE_CONTENT"){
          sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK" + 
          " FROM BBS WHERE TITLE LIKE '%" + req.query.search + "%' OR CONTENT LIKE '%"+  req.query.search +
          "%' ORDER BY NO DESC";
      }
      else{
          sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd hh24:mi:ss'), OK" + 
      " FROM BBS WHERE " +req.query.choice +" LIKE '%" + req.query.search + "%'  ORDER BY NO DESC";
      }
      connection.execute(sql,function(err,rows){
          if(err) console.error("err : "+err);

          res.render('bbs/list',rows);
          connection.release();
      });
  });
});

module.exports = router;
