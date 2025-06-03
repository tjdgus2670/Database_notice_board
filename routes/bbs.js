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

          var sql = "SELECT NO, TITLE, WRITER, CONTENT, to_char(REGDATE,'yyyy-mm-dd'), OK, COUNT  FROM BBS "+
                    " WHERE NO ="+brdno;
          
          connection.execute(sql,function(err,retBBS){
              if(err) console.error("err : " + err);
                       
              connection.release();
              resolve(retBBS);
          });
      });
  });
}


router.get('/read',function(req,res,next){
  console.log("req.query.brdno :"+req.query.brdno);

  read_bbs(req.query.brdno).then( function(retBBS) {
    oracledb.getConnection(dbconfig,function(err,connection){
     
      var sql = "SELECT NO, BBS_NO, WRITER, CONTENT,  to_char(REGDATE,'yyyy-mm-dd'), WCOUNT, OK" +
              " FROM BBSW" +
              " WHERE BBS_NO="+req.query.brdno +
              " ORDER BY NO DESC";
     
      console.log("sql :"+sql);
      connection.execute(sql,function(err,rows){
          if(err) console.error("err : "+err);
          
          res.render('bbs/read', {bbs:retBBS, wbbs:rows});
          connection.release();
      });
    });
  });
});

router.post('/wsave',function(req,res,next){
  var bbsno = req.body.bbsno;
  var code=0;
  if( req.session.user )
  {
    var sql="INSERT INTO BBSW(NO, BBS_NO, WRITER, CONTENT, REGDATE) VALUES(bbsw_seq.nextval,"
          + bbsno+",'"+req.session.user.id+"','"+req.body.wbrdmemo+"', sysdate)";
    console.log("w sql :"+sql);
    oracledb.getConnection(dbconfig,function(err,connection) {
        connection.execute(sql,function(err,rows){
          if(err) console.error("err : "+err);
          res.redirect("/bbs/read?brdno="+bbsno);
          connection.release();
        });
    });
  }
  else
  {
    code = 5;
    res.render('bbs/error', {errcode : code});
    return;
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
