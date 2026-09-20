import { createPostgresStore } from './postgres-store.mjs';
import { hashPassword } from '../../apps/api/src/security.mjs';
import { slugify } from '../shared/domain.mjs';

const databaseUrl=process.env.DATABASE_URL;if(!databaseUrl){console.error('DATABASE_URL is required.');process.exit(1)}
const store=await createPostgresStore(databaseUrl);
try{
  const email=(process.env.SEED_ADMIN_EMAIL??'admin@relay.local').toLowerCase();
  const password=process.env.SEED_ADMIN_PASSWORD??'change-me-in-local-development';
  let user=await store.getUserByEmail(email);
  if(!user)user=await store.createUser({email,displayName:'Relay Admin',passwordHash:await hashPassword(password)});
  let organizations=await store.listOrganizationsForUser(user.id);
  let org=organizations[0];
  if(!org)org=await store.createOrganization({userId:user.id,name:process.env.SEED_ORG_NAME??'Relay Demo',slug:slugify(process.env.SEED_ORG_NAME??'Relay Demo')});
  const services=await store.listServices(org.id);
  let service=services[0]??await store.createService(org.id,{name:'Web Application',slug:'web-application',description:'Primary Relay demo service',operationalState:'OPERATIONAL'});
  const components=await store.listComponents(org.id);
  let component=components[0]??await store.createComponent(org.id,{name:'Dashboard',slug:'dashboard',description:'Customer-facing dashboard',operationalState:'OPERATIONAL',serviceIds:[service.id]});
  const pages=await store.listStatusPages(org.id);
  if(!pages.length)await store.createStatusPage(org.id,{name:'Relay Demo Status',slug:'relay-demo',isPublic:true,componentIds:[component.id],branding:{headline:'Relay Demo',description:'Live service health and incident updates.',accent:'#7c3aed'}});
  console.log(`Seed complete. Sign in as ${email}. Change SEED_ADMIN_PASSWORD outside local development.`);
} finally {await store.close()}
