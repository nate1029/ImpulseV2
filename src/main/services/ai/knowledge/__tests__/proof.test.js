/**
 * Proof-carrying knowledge: every answer the knowledge layer gives says how
 * it is known (knowledge/proof.js), and a proof only counts for the exact
 * text that earned it.
 */
const path = require('path');
const { proof, proofLine, strongest, boardProof, driftProof, recipeProof, componentProof, guideProof, fixProof, PROOFS } = require('../proof');
const { CATALOG, notesText } = require('../boardRecords');
const { COMPONENTS, componentText, componentFacts } = require('../components');
const BoardKnowledge = require('../boardKnowledge');

const CORES = path.join(__dirname, '../../../../../../test/fixtures/cores');
const s3dir = path.join(CORES, 'esp', 'variants', 'esp32s3');
const fakeCli = (variantDir, version = '3.3.12') => async (args) => {
  if (args[0] === 'board' && args[1] === 'details') {
    return {
      success: true,
      stdout: JSON.stringify({
        name: 'ESP32S3 Dev Module', version, package: { name: 'esp32' }, platform: { architecture: 'esp32', name: 'esp32' },
        config_options: [],
        build_properties: ['build.mcu=esp32s3', 'build.f_cpu=240000000L', 'upload.maximum_size=1310720', 'upload.maximum_data_size=327680', `build.variant.path=${variantDir}`, `runtime.platform.path=${path.join(variantDir, '../..')}`, 'build.variant=esp32s3'],
      }),
      stderr: '',
    };
  }
  if (args[1] === 'listall') return { success: true, stdout: JSON.stringify({ boards: [{ name: 'Arduino UNO', fqbn: 'arduino:avr:uno' }] }), stderr: '' };
  if (args[1] === 'search') return { success: true, stdout: JSON.stringify({ boards: [] }), stderr: '' };
  return { success: false, stdout: '', stderr: 'unexpected' };
};
const PROOF = /Proof L[0-6], /;

describe('proof levels', () => {
  test('a proof names its level, what it means and what was checked', () => {
    expect(proofLine(proof(3, 'compiled for arduino:avr:uno with arduino:avr@1.8.8'))).toBe('Proof L3, compiled by Impulse: compiled for arduino:avr:uno with arduino:avr@1.8.8.');
    expect(proofLine(proof(0))).toBe('Proof L0, not yet checked.');
    expect(proof(9).level).toBe(6);
    expect(strongest([proof(1), proof(5), proof(2)]).level).toBe(5);
    expect(strongest([])).toBeNull();
  });

  test('boards the audit checked against their core are L2, with the audit date', () => {
    const audited = CATALOG.find((b) => b.verified === 'core' && (PROOFS.audit.boards || []).includes(b.id));
    expect(audited).toBeTruthy();
    const p = boardProof(audited);
    expect(p.level).toBe(2);
    expect(p.detail).toMatch(new RegExp(`by Impulse's audit on ${PROOFS.audit.date}`));
    const indexed = CATALOG.find((b) => b.verified === 'index');
    expect(boardProof(indexed).level).toBe(1);
  });

  test('a core\'s drift notes are L3 only for the core major version its probe compiled with', () => {
    expect(driftProof('esp32:esp32', '3.3.12').level).toBe(3);
    expect(driftProof('esp32:esp32', '3.3.12').detail).toMatch(/"esp32" probe sketch .* compiled for esp32:esp32:esp32 with esp32:esp32@3/);
    expect(driftProof('esp32:esp32', '2.0.17').level).toBeLessThan(3); // the probe proved core 3, not 2
    expect(driftProof('esp8266:esp8266', '3.1.2').level).toBe(0); // no probe compiled here
  });

  test('a probe proof is void once its sketch changes', () => {
    jest.isolateModules(() => {
      jest.doMock('../proofs.json', () => ({ audit: {}, hardware: {}, probes: { esp32: { fqbn: 'esp32:esp32:esp32', core: 'esp32:esp32@3.3.12', sketch: 'not-the-hash', date: '2026-10-19' } } }));
      const fresh = require('../proof');
      expect(fresh.driftProof('esp32:esp32', '3.3.12').level).toBe(0);
    });
  });

  test('recipes: L3 when compiled, L5 when they ran on a board, L0 otherwise', () => {
    expect(recipeProof('dht', 'esp32s3', { fqbn: 'esp32:esp32:esp32s3', core: 'esp32:esp32@3.3.12' }).level).toBe(3);
    expect(recipeProof('dht', 'esp8266', null).level).toBe(0);
    jest.isolateModules(() => {
      jest.doMock('../proofs.json', () => ({ audit: {}, probes: {}, hardware: { dht: { esp32s3: { board: 'an ESP32-S3 DevKitC', core: 'esp32:esp32@3.3.12', date: '2026-10-19', saw: '23.4 C' } } } }));
      const fresh = require('../proof');
      expect(fresh.recipeProof('dht', 'esp32s3', null)).toMatchObject({ level: 5 });
    });
    expect(fixProof(0)).toBeNull();
    expect(fixProof(12).level).toBe(6);
  });
});

describe('every knowledge answer carries its proof', () => {
  test('component guides and the facts that ride with a request', () => {
    const dht = COMPONENTS.find((c) => c.id === 'dht');
    expect(componentText(dht)).toMatch(/Part facts: Proof L[01], /);
    expect(componentText(dht, { family: 'esp32s3' })).toMatch(/Known-good sketch for the ESP32-S3[^\n]*Proof L3, compiled by Impulse/);
    expect(componentFacts('Read a DHT22', { fqbn: 'esp32:esp32:esp32s3' })).toMatch(PROOF);
    expect(componentProof({ sources: ['https://example.com/datasheet.pdf'] }).level).toBe(1);
  });

  test('board notes, board facts, chip guides and board search', async () => {
    expect(notesText('arduino:avr:uno', { coreVersion: '1.8.8' })).toMatch(/Proof: notes L2 \(read from the installed core\)/);
    expect(notesText('esp32:esp32:esp32s3', { coreVersion: '3.3.12' })).toMatch(/; core API L3 \(compiled by Impulse\)\./);
    const bk = new BoardKnowledge(fakeCli(s3dir));
    const info = await bk.boardInfo('esp32:esp32:esp32s3');
    expect(info.proof.pins).toMatch(/^Proof L2, read from the installed core: esp32:esp32 3\.3\.12/);
    expect(info.proof.coreApi).toMatch(/^Proof L3/);
    expect(await bk.summary('esp32:esp32:esp32s3')).toMatch(/^\[BOARD FACTS, proof L2: read from the installed core\]/);
    expect(await bk.mcuGuide({ chip: 'esp32-s3' })).toMatch(PROOF);
    expect(await bk.mcuGuide({ chip: 'general' })).toMatch(PROOF);
    expect(guideProof('esp32-s3').level).toBe(2); // its pin ranges were audited against the cores
    const found = await bk.search('uno');
    expect(found.filter((b) => b.catalog).every((b) => PROOF.test(b.proof))).toBe(true);
  });
});
