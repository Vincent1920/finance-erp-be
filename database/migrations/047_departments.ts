import {addColumnIfMissing,addForeignKeyIfMissing,type MigrationDatabase} from './helpers'
export const migration={name:'047_departments',async up(db:MigrationDatabase){
 await db.query(`CREATE TABLE IF NOT EXISTS departments(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,company_id BIGINT UNSIGNED NOT NULL,code VARCHAR(30) NOT NULL,name VARCHAR(100) NOT NULL,description TEXT NULL,is_active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,UNIQUE KEY uq_department_code(company_id,code),UNIQUE KEY uq_department_name(company_id,name))`)
 await addColumnIfMissing(db,'payroll_employees','department_id','BIGINT UNSIGNED NULL')
 await db.query(`INSERT IGNORE INTO departments(company_id,code,name) SELECT DISTINCT company_id,CONCAT('DEP-',LEFT(SHA2(TRIM(department),256),12)),TRIM(department) FROM payroll_employees WHERE department IS NOT NULL AND TRIM(department)<>''`)
 await db.query(`UPDATE payroll_employees e JOIN departments d ON d.company_id=e.company_id AND d.name=TRIM(e.department) SET e.department_id=d.id,e.department=d.name WHERE e.department_id IS NULL`)
 await addForeignKeyIfMissing(db,'payroll_employees','fk_employee_department','FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE RESTRICT')
 for(const action of ['view','create','update','delete'])await db.query(`INSERT IGNORE INTO permissions(module,action,name,slug) VALUES('departments','${action}','${action} departments','departments.${action}')`)
 await db.query(`INSERT IGNORE INTO role_permissions(role_id,permission_id) SELECT r.id,p.id FROM roles r JOIN permissions p ON p.module='departments' WHERE r.slug='super-admin'`)
},async down(){throw new Error('Departemen pegawai harus dipertahankan')}}
