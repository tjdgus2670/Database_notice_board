// 파일 경로: /BBS/migrate-password.js

const oracledb = require('oracledb');
const crypto   = require('crypto');

const dbconfig = {
  user: "TEST_USER",
  password: "1234",
  connectString: "localhost/XEPDB1"
};
oracledb.autoCommit = true;

async function migrateUnhashedPasswords() {
  let connection;
  try {
    connection = await oracledb.getConnection(dbconfig);

    // 1) SALT가 없는 계정(=평문 비밀번호 상태) 조회
    const selectSql = `
      SELECT ID, PASSWORD
        FROM LOGIN
       WHERE SALT IS NULL
    `;
    const result = await connection.execute(selectSql);

    if (!result.rows || result.rows.length === 0) {
      console.log("[migrate-password] 해싱 대상 계정이 없습니다.");
      return;
    }

    console.log(`[migrate-password] ${result.rows.length}개의 계정을 마이그레이션합니다.`);

    const updateSql = `
      UPDATE LOGIN
         SET PASSWORD = :newHash,
             SALT     = :newSalt
       WHERE ID = :id
    `;

    for (const row of result.rows) {
      const id            = row[0];
      const plainPassword = row[1]; 
      const newSalt       = crypto.randomBytes(16).toString("base64");
      const newHash       = crypto
                            .createHash("sha512")
                            .update(plainPassword + newSalt)
                            .digest("base64");

      await connection.execute(
        updateSql,
        { newHash, newSalt, id },
        { autoCommit: true }
      );
      console.log(`[migrate-password] ID=${id} 해시 완료`);
    }

    console.log("[migrate-password] 모든 마이그레이션 완료");
  } catch (err) {
    console.error("[migrate-password] 오류 발생:", err);
  } finally {
    if (connection) {
      try { await connection.close(); }
      catch (e) { console.error(e); }
    }
  }
}

module.exports = migrateUnhashedPasswords;
