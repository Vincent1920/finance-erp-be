import { addColumnIfMissing, type MigrationDatabase } from './helpers'
export const migration = {
 name:'041_fifo_costing',
 async up(db:MigrationDatabase){
  await addColumnIfMissing(db,'inventory_movements','cost_method',"VARCHAR(24) NOT NULL DEFAULT 'weighted_average'")
  await db.query(`CREATE TABLE IF NOT EXISTS inventory_cost_layers (
   id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,company_id BIGINT UNSIGNED NOT NULL,item_id BIGINT UNSIGNED NOT NULL,warehouse_id BIGINT UNSIGNED NOT NULL,
   receipt_movement_id BIGINT UNSIGNED NOT NULL,received_date DATE NOT NULL,quantity DECIMAL(20,4) NOT NULL,remaining_quantity DECIMAL(20,4) NOT NULL,
   unit_cost DECIMAL(20,6) NOT NULL,original_value DECIMAL(20,2) NOT NULL,remaining_value DECIMAL(20,2) NOT NULL,
   INDEX fifo_queue(company_id,item_id,warehouse_id,received_date,id),INDEX fifo_receipt(company_id,receipt_movement_id))`)
  await db.query(`CREATE TABLE IF NOT EXISTS inventory_cost_allocations (
   id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,company_id BIGINT UNSIGNED NOT NULL,movement_id BIGINT UNSIGNED NOT NULL,layer_id BIGINT UNSIGNED NOT NULL,
   quantity DECIMAL(20,4) NOT NULL,total_cost DECIMAL(20,2) NOT NULL, INDEX fifo_allocation(company_id,movement_id))`)
  await db.query(`INSERT INTO settings(company_id,setting_key,setting_value,value_type,category,is_secret)
   SELECT id,'inventory.cost_method','weighted_average','string','inventory',0 FROM companies ON DUPLICATE KEY UPDATE setting_key=VALUES(setting_key)`)
 },async down(){throw new Error('FIFO cost history must be retained; restore a verified backup instead')}
}
