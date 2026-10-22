/** operations 提取的单元测试：不联网，用一段仿真的 main.js 片段。 */
import { describe, expect, it } from 'vitest';

import { extractOperations } from '../src/x/operations.js';

const bundle = `
252474(e){e.exports={queryId:"mKwoM54Bz-GinHOAdu6A5g",operationName:"BookmarkSearchTimeline",operationType:"query",metadata:{featureSwitches:["a","b"],fieldToggles:["t1"]}}},
429788(e){e.exports={queryId:"D1nwFlsu_qHsX92YzoRaaA",operationName:"AddContentDisclosure",operationType:"mutation",metadata:{featureSwitches:[],fieldToggles:[]}}},
591231(e){e.exports={queryId:"BYppgupFFS2yqVmmRNjlsw",operationName:"SearchTimeline",operationType:"query",metadata:{featureSwitches:["rweb_video_screen_enabled","responsive_web_grok_analyze_button_fetch_trends_enabled"],fieldToggles:["withArticlePlainText","withGrokAnalyze"]}}},
`;

describe('extractOperations', () => {
  it('从 main.js 片段里抽出 queryId、features 与 fieldToggles', () => {
    const ops = extractOperations(bundle);
    expect(ops.size).toBe(3);

    const search = ops.get('SearchTimeline')!;
    expect(search.queryId).toBe('BYppgupFFS2yqVmmRNjlsw');
    expect(search.operationType).toBe('query');
    expect(Object.keys(search.features)).toEqual([
      'rweb_video_screen_enabled',
      'responsive_web_grok_analyze_button_fetch_trends_enabled',
    ]);
    expect(search.features.rweb_video_screen_enabled).toBe(true);
    expect(search.fieldToggles).toEqual(['withArticlePlainText', 'withGrokAnalyze']);
  });

  it('空 features 也保留该 operation', () => {
    const ops = extractOperations(bundle);
    const mutation = ops.get('AddContentDisclosure')!;
    expect(mutation.operationType).toBe('mutation');
    expect(mutation.features).toEqual({});
  });

  it('匹配不到时返回空表，由调用方决定是否报错', () => {
    expect(extractOperations('no operations here').size).toBe(0);
  });
});
