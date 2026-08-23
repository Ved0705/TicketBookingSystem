import { migrate, resetSchema } from './index.js';
import config from '../config.js';

const fresh = process.argv.includes('--fresh');

if (fresh) {
  resetSchema();
  console.log(`[migrate] schema rebuilt from scratch -> ${config.databaseFile}`);
} else {
  migrate();
  console.log(`[migrate] schema up to date -> ${config.databaseFile}`);
}
