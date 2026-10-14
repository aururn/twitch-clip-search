import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, matchesTitle, filterClips, sanitizeClip, highlightParts, freshScope, mergeCategories, webSearchURL } from '../extension/lib/core.js';

test('タイトル検索はAND・フレーズ・除外と全半角に対応する', () => {
  assert.equal(matchesTitle('初見でＡＰＥＸの神プレイ', parseQuery('初見 apex -失敗')), true);
  assert.equal(matchesTitle('初見でAPEXに失敗', parseQuery('初見 apex -失敗')), false);
  assert.equal(matchesTitle('A nice shot!', parseQuery('"nice shot"')), true);
  assert.equal(matchesTitle('nice try, good shot', parseQuery('"nice shot"')), false);
  assert.equal(matchesTitle('大爆笑', parseQuery('爆笑')), true);
  assert.equal(matchesTitle('半角ｶﾞｯﾂﾎﾟｰｽﾞ', parseQuery('ガッツポーズ')), true);
});

test('配信者名を検索対象に混ぜず期間・言語を適用する', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');
  const clips = [
    { slug: '1', title: '爆笑の瞬間', broadcaster: 'Alice', language: 'JA', createdAt: '2026-10-14T00:00:00Z', views: 5 },
    { slug: '2', title: '普通の瞬間', broadcaster: '爆笑', language: 'JA', createdAt: '2026-10-14T00:00:00Z', views: 100 },
    { slug: '3', title: '爆笑の瞬間', language: 'EN', createdAt: '2026-10-14T00:00:00Z', views: 10 },
    { slug: '4', title: '爆笑の瞬間', language: 'JA', createdAt: '2026-01-01T00:00:00Z', views: 50 },
  ];
  assert.deepEqual(filterClips(clips, { query: '爆笑' }, now).map(clip => clip.slug), ['4', '1'], '初期状態では古いクリップを除外しない');
  assert.deepEqual(filterClips(clips, { query: '爆笑', period: 'LAST_MONTH' }, now).map(clip => clip.slug), ['1']);
  assert.deepEqual(filterClips(clips, { query: '爆笑', language: 'ALL', period: 'ALL_TIME' }, now).map(clip => clip.slug), ['4', '3', '1']);
  assert.deepEqual(filterClips(clips, { query: '爆笑', language: 'ALL', period: 'ALL_TIME', sort: 'oldest' }, now).map(clip => clip.slug), ['4', '1', '3']);
});

test('強調表示はUnicode正規化後も元の文字を保持する', () => {
  const title = 'ＡＰＥＸでｶﾞｯﾂﾎﾟｰｽﾞ！';
  const parts = highlightParts(title, parseQuery('apex ガッツポーズ'));
  assert.equal(parts.map(part => part.text).join(''), title);
  assert.deepEqual(parts.filter(part => part.hit).map(part => part.text), ['ＡＰＥＸ', 'ｶﾞｯﾂﾎﾟｰｽﾞ']);
  assert.deepEqual(highlightParts('<img onerror=x>爆笑', parseQuery('爆笑')).at(-1), { text: '爆笑', hit: true });
});

test('外部データのURLはTwitchのクリップと画像に制限する', () => {
  const node = { slug: 'Valid-Slug_123', title: '<script>alert(1)</script>', createdAt: '2026-10-10T00:00:00Z', language: 'ja', thumbnailURL: 'https://evil.example/1.jpg' };
  const clip = sanitizeClip(node, 'Minecraft');
  assert.equal(clip.url, 'https://clips.twitch.tv/Valid-Slug_123');
  assert.equal(clip.image, '');
  assert.equal(clip.language, 'JA');
  assert.equal(sanitizeClip({ ...node, slug: '../javascript:evil' }), null);
  assert.equal(sanitizeClip({ ...node, createdAt: 'invalid' }), null);
});

test('カテゴリを重複なく追加し検索語を外部検索URLへ安全にエンコードする', () => {
  const scope = freshScope('LAST_MONTH', 'JA');
  const size = scope.categories.length;
  mergeCategories(scope, ['Minecraft', 'New Game', 'New Game']);
  assert.equal(scope.categories.length, size + 1);
  const url = new URL(webSearchURL('爆笑 初見 -失敗'));
  assert.equal(url.hostname, 'www.google.com');
  assert.match(url.searchParams.get('q'), /intitle:"爆笑" intitle:"初見"/);
});
