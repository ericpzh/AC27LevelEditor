import { describe, it, expect } from 'vitest';
import { MCP_TOOLS } from '../../electron/api-server';

describe('api-server — air MCP tools', () => {
  it('exposes air tools', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    for (const n of ['create_airway_nodes', 'create_airway_procedures', 'delete_airway_objects', 'move_airway_objects', 'rename_airway_object', 'create_airway_fillet']) {
      expect(names).toContain(n);
    }
  });
  it('get_ground_painter_state summary includes airway counts', () => {
    const def = MCP_TOOLS.find((t) => t.name === 'get_ground_painter_state');
    expect(def).toBeTruthy();
    expect(def.description).toMatch(/graph/);
  });
});
