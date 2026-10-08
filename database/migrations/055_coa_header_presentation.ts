import type {MigrationDatabase} from './helpers'
export const migration={name:'055_coa_header_presentation',async up(db:MigrationDatabase){
 await db.query(`WITH RECURSIVE descendants AS (
 SELECT id root_id,id node_id,company_id,0 depth FROM accounts WHERE is_header=TRUE AND deleted_at IS NULL
 UNION ALL SELECT d.root_id,c.id,c.company_id,d.depth+1 FROM descendants d JOIN accounts c ON c.parent_id=d.node_id AND c.company_id=d.company_id WHERE c.deleted_at IS NULL AND d.depth<32
 ), ranks AS (SELECT d.root_id,GREATEST(0,MIN(CAST(a.presentation_order AS SIGNED)-d.depth)) header_order FROM descendants d JOIN accounts a ON a.id=d.node_id AND a.company_id=d.company_id WHERE d.depth>0 AND a.is_posting=TRUE AND a.presentation_order IS NOT NULL GROUP BY d.root_id)
 UPDATE accounts a JOIN ranks r ON r.root_id=a.id SET a.presentation_order=LEAST(COALESCE(a.presentation_order,r.header_order),r.header_order) WHERE a.is_header=TRUE`)
},async down(){throw new Error('Preserve COA presentation hierarchy')}}
