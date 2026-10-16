#!/usr/bin/env node
/**
 * Helper setup data "building" di ThingsBoard (memakai kredensial tenant dari .env).
 * Semua perintah yang menulis ke TB default DRY-RUN; tambahkan --apply untuk benar-benar menulis.
 *
 *   npm run setup -- list
 *   npm run setup -- create --name "Rukita Amani" [--label "Amani, Jaksel"] [--apply]
 *   npm run setup -- link --building <id|nama> --match "Amani|AMN" [--apply]
 *   npm run setup -- link --building <id|nama> --devices <uuid,uuid> [--space <assetId>] [--apply]
 *   npm run setup -- dashboards --building <id|nama> --set <dashUuid,dashUuid> [--apply]
 *   npm run setup -- show --building <id|nama>
 */
import { loadDotEnv } from '../src/config.js';
import { TbClient } from '../src/tbClient.js';

loadDotEnv();
const env = process.env;
const TYPE = env.BUILDING_ASSET_TYPE || 'building';
const REL = env.BUILDING_RELATION_TYPE || 'Contains';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const [cmd, ...rest] = process.argv.slice(2);
const args = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    args[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  }
}
const APPLY = Boolean(args.apply);

if (!env.TB_TENANT_USERNAME || !env.TB_TENANT_PASSWORD) {
  console.error('Set TB_TENANT_USERNAME / TB_TENANT_PASSWORD di .env dulu');
  process.exit(1);
}
const tb = new TbClient({
  baseUrl: (env.TB_INTERNAL_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  username: env.TB_TENANT_USERNAME,
  password: env.TB_TENANT_PASSWORD,
});

async function pageAll(path) {
  const out = [];
  for (let page = 0; page < 100; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const r = await tb.asTenant('GET', `${path}${sep}pageSize=100&page=${page}`);
    out.push(...r.data);
    if (!r.hasNext) break;
  }
  return out;
}

async function buildings() {
  return pageAll(`/api/tenant/assets?type=${encodeURIComponent(TYPE)}`);
}

async function resolveBuilding(ref) {
  if (!ref) throw new Error('--building wajib');
  const all = await buildings();
  const b = UUID.test(ref) ? all.find((a) => a.id.id === ref.toLowerCase()) : all.filter((a) => a.name.toLowerCase() === ref.toLowerCase());
  const one = Array.isArray(b) ? (b.length === 1 ? b[0] : null) : b;
  if (!one) throw new Error(`building "${ref}" tidak ditemukan / ambigu (cek: npm run setup -- list)`);
  return one;
}

async function relations(bid) {
  return tb.asTenant('POST', '/api/relations/info', {
    parameters: { rootId: bid, rootType: 'ASSET', direction: 'FROM', relationTypeGroup: 'COMMON', maxLevel: 5, fetchLastLevelOnly: false },
    filters: [{ relationType: REL, entityTypes: ['ASSET', 'DEVICE'] }],
  });
}

const dry = () => console.log(APPLY ? '' : '\n(DRY-RUN — tambahkan --apply untuk menulis ke TB)');

const commands = {
  async list() {
    const all = await buildings();
    if (!all.length) console.log(`Belum ada asset type "${TYPE}". Buat dengan: npm run setup -- create --name "..." --apply`);
    for (const b of all) {
      const rels = await relations(b.id.id);
      const n = rels.filter((r) => r.to.entityType === 'DEVICE').length;
      console.log(`${b.id.id}  ${b.name.padEnd(32)} ${String(n).padStart(4)} device`);
    }
    const devs = await pageAll('/api/tenant/deviceInfos');
    console.log(`\nTotal device di tenant: ${devs.length}`);
  },

  async create() {
    if (!args.name) throw new Error('--name wajib');
    const exists = (await buildings()).find((a) => a.name.toLowerCase() === args.name.toLowerCase());
    if (exists) return console.log(`Sudah ada: ${exists.id.id} ${exists.name}`);
    const body = { name: args.name, type: TYPE, label: typeof args.label === 'string' ? args.label : undefined };
    console.log('Akan membuat asset:', body);
    if (APPLY) {
      const a = await tb.asTenant('POST', '/api/asset', body);
      console.log(`Dibuat: ${a.id.id}`);
    }
    dry();
  },

  async link() {
    const b = await resolveBuilding(args.building);
    const from = UUID.test(args.space ?? '') ? { id: args.space.toLowerCase(), entityType: 'ASSET' } : { id: b.id.id, entityType: 'ASSET' };
    const existing = new Set((await relations(b.id.id)).filter((r) => r.to.entityType === 'DEVICE').map((r) => r.to.id));
    const devs = await pageAll('/api/tenant/deviceInfos');
    let picked;
    if (typeof args.devices === 'string') {
      const want = new Set(args.devices.split(',').map((s) => s.trim().toLowerCase()));
      picked = devs.filter((d) => want.has(d.id.id));
    } else if (typeof args.match === 'string') {
      const re = new RegExp(args.match, 'i');
      picked = devs.filter((d) => re.test(d.name) || re.test(d.label ?? ''));
    } else throw new Error('pakai --match <regex> atau --devices <uuid,...>');

    const todo = picked.filter((d) => !existing.has(d.id.id));
    console.log(`Building: ${b.name} (${b.id.id})${from.id !== b.id.id ? `, space ${from.id}` : ''}`);
    console.log(`Cocok ${picked.length} device, ${picked.length - todo.length} sudah ter-link, ${todo.length} akan di-link:`);
    for (const d of todo) console.log(`  + ${d.id.id}  ${d.name}${d.label ? ` (${d.label})` : ''}  [${d.type}]`);
    if (APPLY) {
      for (const d of todo) {
        await tb.asTenant('POST', '/api/relation', { from, to: { id: d.id.id, entityType: 'DEVICE' }, type: REL, typeGroup: 'COMMON' });
      }
      console.log(`Selesai: ${todo.length} relasi "${REL}" dibuat.`);
    }
    dry();
  },

  async dashboards() {
    const b = await resolveBuilding(args.building);
    if (typeof args.set !== 'string') throw new Error('--set <dashUuid,...> wajib');
    const ids = args.set.split(',').map((s) => s.trim().toLowerCase());
    const list = [];
    for (const id of ids) {
      if (!UUID.test(id)) throw new Error(`${id} bukan UUID`);
      const info = await tb.asTenant('GET', `/api/dashboard/info/${id}`);
      list.push({ id, title: info.title });
    }
    console.log(`Building ${b.name}: dashboards =`, list);
    if (APPLY) {
      await tb.asTenant('POST', `/api/plugins/telemetry/ASSET/${b.id.id}/attributes/SERVER_SCOPE`, { dashboards: list });
      console.log('Tersimpan di server attribute "dashboards".');
    }
    dry();
  },

  async show() {
    const b = await resolveBuilding(args.building);
    const rels = await relations(b.id.id);
    console.log(`${b.name} (${b.id.id})`);
    const children = new Map();
    for (const r of rels) {
      if (!children.has(r.from.id)) children.set(r.from.id, []);
      children.get(r.from.id).push(r);
    }
    const walk = (id, depth, seen = new Set()) => {
      if (seen.has(id)) return;
      seen.add(id);
      for (const r of children.get(id) ?? []) {
        console.log(`${'  '.repeat(depth)}${r.to.entityType === 'DEVICE' ? '•' : '▸'} ${r.toName} (${r.to.id})`);
        if (r.to.entityType === 'ASSET') walk(r.to.id, depth + 1, seen);
      }
    };
    walk(b.id.id, 1);
  },
};

if (!commands[cmd]) {
  console.log('Perintah: list | create | link | dashboards | show   (lihat komentar di atas file)');
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
