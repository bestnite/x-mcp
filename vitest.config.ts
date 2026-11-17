import { defineConfig } from 'vitest/config';

/**
 * 只跑仓库根的 `test/`。
 *
 * worktree 默认落在 `.agents/` 下，而 `.agents/` 被 gitignore 后仍然在磁盘上，
 * 默认的 glob 会把 worktree 里那批同样的测试再跑一遍——结果是「76 项全绿」这种
 * 双倍计数，看着更绿，其实一个字节都没多验证。
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/.agents/**'],
  },
});
