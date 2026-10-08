import type { MigrationDatabase } from './helpers'
export const migration={name:'052_auth_sessions',async up(db:MigrationDatabase){
 await db.query(`CREATE TABLE IF NOT EXISTS auth_sessions(id CHAR(36) PRIMARY KEY,company_id BIGINT UNSIGNED NOT NULL,user_id BIGINT UNSIGNED NOT NULL,token_hash CHAR(64) NOT NULL UNIQUE,device_label VARCHAR(255) NOT NULL DEFAULT '',created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),expires_at DATETIME(3) NOT NULL,revoked_at DATETIME(3) NULL,KEY ix_user_sessions(company_id,user_id,revoked_at),FOREIGN KEY(user_id) REFERENCES users(id),FOREIGN KEY(company_id) REFERENCES companies(id))`)
 await db.query(`CREATE TABLE IF NOT EXISTS auth_login_limits(bucket CHAR(64) PRIMARY KEY,attempts INT NOT NULL DEFAULT 0,reset_at DATETIME(3) NOT NULL)`)
},async down(){throw new Error('Preserve session audit history')}}
