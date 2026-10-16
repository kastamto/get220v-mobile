#!/usr/bin/env node
// Generate API key baru untuk sebuah app + hash sha256 untuk apps.json.
// Pakai: npm run hash-key            -> key acak baru
//        npm run hash-key -- <key>   -> hash key yang sudah ada
import { createHash, randomBytes } from 'node:crypto';

const key = process.argv[2] || `g220v_${randomBytes(24).toString('base64url')}`;
const hash = createHash('sha256').update(key).digest('hex');
console.log(`API key  (berikan ke app, simpan di backend app tsb): ${key}`);
console.log(`keySha256 (taruh di clients.json):                       ${hash}`);
