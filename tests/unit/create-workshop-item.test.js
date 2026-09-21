import { describe, it, expect } from 'vitest';
import {
  escapeVdf,
  buildWorkshopVdf,
  parsePublishedFileId,
  buildSteamCmdArgs,
  parseArgs,
  interpretPublishedFileDetails,
  checkExistingItem,
  interpretAppDetails,
  fetchAppDetails,
  queryWorkshopTotal,
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

  it('escapes backslashes, newlines and tabs; downgrades double quotes (steamcmd cannot parse \\")', () => {
    expect(escapeVdf('C:\\a\\b')).toBe('C:\\\\a\\\\b');
    expect(escapeVdf('say "hi"')).toBe("say 'hi'");
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

  it('parses --force and --skip-check as booleans, defaulting to false', () => {
    expect(parseArgs(['--appid', '1'])).toMatchObject({ force: false, 'skip-check': false });
    expect(parseArgs(['--appid', '1', '--force', '--skip-check'])).toMatchObject({
      force: true, 'skip-check': true,
    });
  });
});

describe('create-workshop-item — existence guard', () => {
  it('reports exists-same-app when the live item belongs to the target', () => {
    const json = { response: { result: 1, resultcount: 1, publishedfiledetails: [
      { publishedfileid: '3793213548', result: 1, consumer_appid: 3328490 },
    ] } };
    expect(interpretPublishedFileDetails(json, { targetAppId: '3328490', fileId: '3793213548' }))
      .toMatchObject({ status: 'exists-same-app', itemAppId: '3328490' });
  });

  it('reads the real API shape (consumer_app_id with underscore)', () => {
    const json = { response: { publishedfiledetails: [
      { publishedfileid: '3793213548', result: 1, creator_app_id: 4004140, consumer_app_id: 4004140 },
    ] } };
    const out = interpretPublishedFileDetails(json, { targetAppId: '3328490', fileId: '3793213548' });
    expect(out).toMatchObject({ status: 'exists-other-app', itemAppId: '4004140' });
  });

  it('falls back to creator_appid when consumer_appid is absent', () => {
    const json = { response: { publishedfiledetails: [
      { publishedfileid: '1', result: 1, creator_appid: 3328490 },
    ] } };
    expect(interpretPublishedFileDetails(json, { targetAppId: 3328490, fileId: '1' }).status)
      .toBe('exists-same-app');
  });

  it('reports exists-other-app for a live item under another app', () => {
    const json = { response: { publishedfiledetails: [
      { publishedfileid: '3793213548', result: 1, consumer_appid: 4004140 },
    ] } };
    const out = interpretPublishedFileDetails(json, { targetAppId: '3328490', fileId: '3793213548' });
    expect(out.status).toBe('exists-other-app');
    expect(out.url).toContain('3793213548');
  });

  it('reports missing for result 9, empty details, or garbage', () => {
    expect(interpretPublishedFileDetails(
      { response: { publishedfiledetails: [{ result: 9 }] } },
      { targetAppId: '1', fileId: '1' },
    ).status).toBe('missing');
    expect(interpretPublishedFileDetails(
      { response: { resultcount: 0, publishedfiledetails: [] } },
      { targetAppId: '1', fileId: '1' },
    ).status).toBe('missing');
    expect(interpretPublishedFileDetails({}, { targetAppId: '1', fileId: '1' }).status)
      .toBe('missing');
  });

  it('posts itemcount + id and interprets the response', async () => {
    let seen = null;
    const fetchFn = async (url, opts) => {
      seen = { url, body: String(opts.body) };
      return {
        ok: true,
        text: async () => JSON.stringify({ response: { publishedfiledetails: [
          { result: 1, consumer_appid: 3328490 },
        ] } }),
      };
    };
    const out = await checkExistingItem({ fileId: '99', targetAppId: '3328490', fetchFn });
    expect(out.status).toBe('exists-same-app');
    expect(seen.url).toMatch(/GetPublishedFileDetails/);
    expect(seen.body).toContain('itemcount=1');
    expect(seen.body).toContain('99');
  });

  it('returns unknown on HTTP failure or unparseable body', async () => {
    const badHttp = await checkExistingItem({
      fileId: '1', targetAppId: '1',
      fetchFn: async () => ({ ok: false, text: async () => 'denied' }),
    });
    expect(badHttp.status).toBe('unknown');
    const badJson = await checkExistingItem({
      fileId: '1', targetAppId: '1',
      fetchFn: async () => ({ ok: true, text: async () => 'not json' }),
    });
    expect(badJson.status).toBe('unknown');
  });

  it('propagates network errors so the caller can warn and continue', async () => {
    const fetchFn = async () => { throw new Error('offline'); };
    await expect(checkExistingItem({ fileId: '1', targetAppId: '1', fetchFn }))
      .rejects.toThrow('offline');
  });
});

describe('create-workshop-item — app probe', () => {
  it('parses --probe-app as a value flag', () => {
    expect(parseArgs(['--probe-app', '3328490'])).toMatchObject({ 'probe-app': '3328490' });
    expect(() => parseArgs(['--probe-app'])).toThrow(/missing value/);
  });

  it('interprets store appdetails (found / not found / garbage)', () => {
    expect(interpretAppDetails(
      { 3328490: { success: true, data: { name: 'Airport Control 27', type: 'game' } } },
      { appid: '3328490' },
    )).toEqual({ found: true, name: 'Airport Control 27', type: 'game' });
    expect(interpretAppDetails({ 1: { success: false } }, { appid: '1' }).found).toBe(false);
    expect(interpretAppDetails({}, { appid: '1' }).found).toBe(false);
  });

  it('fetches appdetails from the store endpoint', async () => {
    let seen = null;
    const fetchFn = async (url) => {
      seen = url;
      return { ok: true, text: async () => JSON.stringify({ 7: { success: true, data: { name: 'N', type: 'game' } } }) };
    };
    expect(await fetchAppDetails({ appid: '7', fetchFn }))
      .toEqual({ found: true, name: 'N', type: 'game' });
    expect(seen).toMatch(/appdetails\?appids=7/);
  });

  it('flags HTTP / parse failures on the store lookup', async () => {
    const badHttp = await fetchAppDetails({ appid: '1', fetchFn: async () => ({ ok: false, text: async () => 'x' }) });
    expect(badHttp).toMatchObject({ found: false, error: true });
    const badJson = await fetchAppDetails({ appid: '1', fetchFn: async () => ({ ok: true, text: async () => '-html-' }) });
    expect(badJson).toMatchObject({ found: false, error: true });
  });

  it('queries the Workshop total with a key, and skips without one', async () => {
    let seen = null;
    const fetchFn = async (url) => {
      seen = url;
      return { ok: true, text: async () => JSON.stringify({ response: { result: 1, total: 3 } }) };
    };
    expect(await queryWorkshopTotal({ appid: '3328490', key: 'K', fetchFn }))
      .toEqual({ ok: true, total: 3, reason: null });
    expect(seen).toMatch(/QueryFiles/);
    expect(seen).toContain('totalonly=true');
    expect(await queryWorkshopTotal({ appid: '1', key: '', fetchFn }))
      .toEqual({ ok: false, total: null, reason: 'no-key' });
  });

  it('reports api-error on denied keys or bad payloads', async () => {
    const denied = await queryWorkshopTotal({
      appid: '1', key: 'K',
      fetchFn: async () => ({ ok: false, text: async () => '<html>Forbidden</html>' }),
    });
    expect(denied).toMatchObject({ ok: false, reason: 'bad-payload' });
    const apiError = await queryWorkshopTotal({
      appid: '1', key: 'K',
      fetchFn: async () => ({ ok: true, text: async () => JSON.stringify({ response: { result: 2 } }) }),
    });
    expect(apiError).toMatchObject({ ok: false, reason: 'api-error' });
    const badPayload = await queryWorkshopTotal({
      appid: '1', key: 'K',
      fetchFn: async () => ({ ok: true, text: async () => 'not json' }),
    });
    expect(badPayload).toMatchObject({ ok: false, reason: 'bad-payload' });
  });
});
