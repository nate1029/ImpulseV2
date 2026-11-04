import { Circuit, solveIsland, logicLevel } from '../netlist.js';

const rails = (map) => (net) => map.get(net) || [];

describe('Circuit', () => {
  it('merges linked nodes into nets and keeps unwired nodes alone', () => {
    const c = new Circuit({
      nodes: ['uno:13', 'led:A', 'led:C', 'uno:GND.1', 'btn:1.l'],
      links: [['uno:13', 'r:1'], ['r:2', 'led:A'], ['led:C', 'uno:GND.1']],
      resistors: [['r:1', 'r:2', 220]],
    });
    expect(c.connected('uno:13', 'r:1')).toBe(true);
    expect(c.connected('uno:13', 'led:A')).toBe(false);
    expect(c.connected('led:C', 'uno:GND.1')).toBe(true);
    expect(c.netOf('btn:1.l')).toBeGreaterThanOrEqual(0);
    expect(c.netOf('nope:1')).toBe(-1);
    const anode = c.netOf('led:A');
    expect(c.resistiveNeighbors(anode)).toEqual([{ net: c.netOf('uno:13'), ohms: 220, hops: 1 }]);
    expect(c.islandOf[anode]).toBe(c.islandOf[c.netOf('uno:13')]);
  });
});

describe('solveIsland', () => {
  function solve(spec, sources) {
    const c = new Circuit(spec);
    const byNet = new Map();
    for (const [node, list] of Object.entries(sources)) byNet.set(c.netOf(node), list);
    const node = (n) => c.netOf(n);
    const island = (n) => c.islandOf[node(n)];
    return { c, node, at: (n) => solveIsland(c, island(n), rails(byNet)).volts.get(node(n)), result: (n) => solveIsland(c, island(n), rails(byNet)) };
  }

  it('solves a voltage divider', () => {
    const { at } = solve(
      { resistors: [['vcc', 'mid', 10000], ['mid', 'gnd', 10000]] },
      { vcc: [{ volts: 5 }], gnd: [{ volts: 0 }] });
    expect(at('mid')).toBeCloseTo(2.5, 6);
  });

  it('models a potentiometer as two resistors', () => {
    const pos = 0.25; // wiper a quarter of the way from GND
    const { at } = solve(
      { links: [['pot:VCC', '5V'], ['pot:GND', 'GND'], ['pot:SIG', 'A0']], resistors: [['pot:VCC', 'pot:SIG', 10000 * (1 - pos)], ['pot:SIG', 'pot:GND', 10000 * pos]] },
      { '5V': [{ volts: 5 }], GND: [{ volts: 0 }] });
    expect(at('A0')).toBeCloseTo(1.25, 6);
  });

  it('lets an external pull-down beat a weak internal pull-up', () => {
    const { at } = solve(
      { resistors: [['pin', 'gnd', 10000]] },
      { pin: [{ volts: 5, ohms: 35000 }], gnd: [{ volts: 0 }] });
    expect(logicLevel(at('pin'))).toBe(0);
  });

  it('reads a pulled-up input as HIGH and an unconnected input as floating', () => {
    expect(logicLevel(solve({ nodes: ['pin'] }, { pin: [{ volts: 5, ohms: 35000 }] }).at('pin'))).toBe(1);
    expect(solve({ nodes: ['pin'] }, {}).at('pin')).toBeNull();
    expect(solve({ resistors: [['a', 'b', 1000]] }, {}).at('a')).toBeNull();
  });

  it('reports a short between two ideal sources and settles low', () => {
    const { result, node } = solve(
      { links: [['uno:13', 'uno:GND.1']] },
      { 'uno:13': [{ volts: 5, tag: 'D13' }, { volts: 0, tag: 'GND' }] });
    const r = result('uno:13');
    expect(r.shorts).toEqual([{ net: node('uno:13'), tags: ['D13', 'GND'] }]);
    expect(r.volts.get(node('uno:13'))).toBe(0);
  });

  it('passes a driven level through a series resistor', () => {
    const { at } = solve(
      { resistors: [['out', 'in', 220]] },
      { out: [{ volts: 5 }] });
    expect(at('in')).toBeCloseTo(5, 6);
  });
});
