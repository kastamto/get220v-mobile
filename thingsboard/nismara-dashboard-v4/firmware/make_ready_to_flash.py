#!/usr/bin/env python3
"""Membuat folder SIAP-FLASH per device di firmware/ready_to_flash/ dari SATU sumber kode.

  nismara_gwt/              -> ready_to_flash/nismara_gwt/
  nismara_irrigation/       -> ready_to_flash/nismara_garden_lt1/   (PROFILE_GARDEN_LT1 aktif)
                            -> ready_to_flash/nismara_garden_roof/  (PROFILE_GARDEN_ROOF aktif)

Arduino IDE mensyaratkan nama folder = nama file .ino, jadi tiap folder berisi <nama>.ino + config.h.
Folder ini HASIL GENERATE — jangan diedit tangan. Edit sumber (nismara_gwt/, nismara_irrigation/) lalu jalankan:

    python3 -I make_ready_to_flash.py          # tulis ulang ready_to_flash/
    python3 -I make_ready_to_flash.py --check  # gagal (exit 1) bila ready_to_flash/ tidak sinkron dengan sumber
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'ready_to_flash')
BANNER = ('// ====================================================================\n'
          '// FILE HASIL GENERATE (make_ready_to_flash.py) — jangan diedit tangan.\n'
          '// Sumber: firmware/{src}/   Device: {dev}\n'
          '// ====================================================================\n')


def read(p):
    with open(os.path.join(HERE, p), encoding='utf-8') as f:
        return f.read()


def set_profile(cfg: str, profile: str) -> str:
    """Aktifkan tepat satu profil (LT1 / ROOF) dan nonaktifkan yang lain."""
    def line(name, on):
        return re.sub(rf'^(//)?(\s*)#define {name}\b', (r'\2' if on else r'//\2') + f'#define {name}', cfg_ref[0], flags=re.M)
    cfg_ref = [cfg]
    for name in ('PROFILE_GARDEN_LT1', 'PROFILE_GARDEN_ROOF'):
        cfg_ref[0] = line(name, name == profile)
    return cfg_ref[0]


def build():
    files = {}
    gwt_ino, gwt_cfg = read('nismara_gwt/nismara_gwt.ino'), read('nismara_gwt/config.h')
    files['nismara_gwt/nismara_gwt.ino'] = BANNER.format(src='nismara_gwt', dev='GWT') + gwt_ino
    files['nismara_gwt/config.h'] = BANNER.format(src='nismara_gwt', dev='GWT') + gwt_cfg

    irr_ino, irr_cfg = read('nismara_irrigation/nismara_irrigation.ino'), read('nismara_irrigation/config.h')
    for folder, profile, dev, token in (('nismara_garden_lt1', 'PROFILE_GARDEN_LT1', 'Garden Lt.1 (2 zona)', 'TOKEN_GARDEN_LT1'),
                                        ('nismara_garden_roof', 'PROFILE_GARDEN_ROOF', 'Garden Roof (1 zona)', 'TOKEN_GARDEN_ROOF')):
        cfg = set_profile(irr_cfg, profile)
        cfg = cfg.replace('#define TB_TOKEN        "DEVICE_ACCESS_TOKEN"', f'#define TB_TOKEN        "{token}"')
        files[f'{folder}/{folder}.ino'] = BANNER.format(src='nismara_irrigation', dev=dev) + irr_ino
        files[f'{folder}/config.h'] = BANNER.format(src='nismara_irrigation', dev=dev) + cfg
    return files


def main():
    files = build()
    if '--check' in sys.argv:
        stale = []
        for rel, content in files.items():
            p = os.path.join(OUT, rel)
            if not os.path.exists(p) or open(p, encoding='utf-8').read() != content:
                stale.append(rel)
        if stale:
            print('FAIL ready_to_flash tidak sinkron dengan sumber:', ', '.join(stale))
            print('     jalankan: python3 -I firmware/make_ready_to_flash.py')
            sys.exit(1)
        print(f'ok   ready_to_flash sinkron dengan sumber ({len(files)} file)')
        return
    for rel, content in files.items():
        p = os.path.join(OUT, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(content)
    print(f'ditulis {len(files)} file ke {OUT}')


if __name__ == '__main__':
    main()
