import { describe, it, expect } from 'vitest';
import {
  escapeVdf,
  buildWorkshopVdf,
  parsePublishedFileId,
  buildSteamCmdArgs,
  parseArgs,
} from '../../scripts/create-workshop-item.mjs';

describe('create-workshop-item — VDF', () => {
  it('creates a VDF with appid and no publishedfileid', () => {
    const vdf = buildWorkshopVdf({
      appid: '3328490',
      contentfolder: 'C:\\build\\content',
      previewfile: 'C:\\repo\\icon.png',
      visibility: '2',
      title: 'AC27Editor',
      changenote: 'first',
    });
    expect(vdf).toContain('"workshopitem"');
    expect(vdf).toContain('"appid"');
    expect(vdf).toContain('"3328490"');
    expect(vdf).not.toContain('"publishedfileid"');
    expect(vdf).toContain('"visibility"');
    expect(vdf.endsWith('}\n')).toBe(true);
  });

  it('includes publishedfileid when given (update form)', () => {
    const vdf = buildWorkshopVdf({ appid: '4004140', publishedfileid: '3793213548' });
    expect(vdf).toContain('"publishedfileid"');
    expect(vdf).toContain('"3793213548"');
  });

  it('escapes backslashes, quotes, newlines and tabs', () => {
    expect(escapeVdf('C:\\a\\b')).toBe('C:\\\\a\\\\b');
    expect(escapeVdf('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeVdf('a\r\nb\nc')).toBe('a\\nb\\nc');
    expect(escapeVdf('a\tb')).toBe('a\\tb');
  });

  it('writes multi-line descriptions as a single escaped line', () => {
    const vdf = buildWorkshopVdf({ appid: '1', description: 'line1\nline2' });
    expect(vdf).toContain('"line1\\nline2"');
    expect(vdf.split('\n').filter((l) => l.includes('line1'))).toHaveLength(1);
  });

  it('skips empty optional fields', () => {
    const vdf = buildWorkshopVdf({ appid: '1', contentfolder: '', previewfile: null });
    expect(vdf).not.toContain('"contentfolder"');
    expect(vdf).not.toContain('"previewfile"');
  });
});

describe('create-workshop-item — steamcmd handoff', () => {
  it('reads the publishedfileid steamcmd writes back', () => {
    const written = '"workshopitem"\n{\n    "appid"    "3328490"\n    "publishedfileid"    "1234567890"\n}\n';
    expect(parsePublishedFileId(written)).toBe('1234567890');
    expect(parsePublishedFileId('"workshopitem"\n{\n}')).toBeNull();
  });

  it('builds the login + workshop_build_item argument list', () => {
    expect(buildSteamCmdArgs({ username: 'erikaze', vdfPath: '/tmp/item.vdf' })).toEqual([
      '+login',
      'erikaze',
      '+workshop_build_item',
      '/tmp/item.vdf',
      '+quit',
    ]);
  });
});

describe('create-workshop-item — args', () => {
  it('parses flags, defaults visibility to private and run to false', () => {
    const args = parseArgs(['--appid', '3328490', '--content', './x']);
    expect(args).toMatchObject({ appid: '3328490', content: './x', visibility: '2', run: false });
  });

  it('turns --run into a boolean and accepts multi-word values', () => {
    const args = parseArgs(['--appid', '1', '--title', 'AC27 Editor', '--run']);
    expect(args.title).toBe('AC27 Editor');
    expect(args.run).toBe(true);
  });

  it('rejects a missing value and unknown positional args', () => {
    expect(() => parseArgs(['--appid'])).toThrow(/missing value/);
    expect(() => parseArgs(['stray'])).toThrow(/unexpected argument/);
  });
});
