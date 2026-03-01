<cloudflare-workers-monorepo>

<title>Cloudflare Workers Monorepo Guidelines for AmpCode</title>

<commands>
- `just install` - Install dependencies
- `just dev` - Run development servers
- `just test` - Run all tests
- `just build` - Build all workers
- `just check` - Check deps, lint, types, format
- `just fix` - Fix code issues
- `just deploy` - Deploy all workers
- `just preview` - Run Workers in preview mode
- `just gen` - Create new Cloudflare Worker
- `just new-package` - Create new shared package
- `just cs` - Create changeset
- `bun turbo -F worker-name dev` - Start specific worker
- `bun turbo -F worker-name test` - Test specific worker
- `bun turbo -F worker-name build` - Build specific worker
- `bun turbo -F worker-name deploy` - Deploy specific worker
- `bun vitest path/to/test.test.ts` - Run single test file
- `pnpm -F @repo/package-name add dependency` - Add dependency to package
</commands>

<architecture>
- Cloudflare Workers monorepo using pnpm workspaces and Turborepo
- `apps/` - Individual Cloudflare Worker applications
- `packages/` - Shared libraries and configurations
  - `@repo/eslint-config` - Shared ESLint configuration
  - `@repo/typescript-config` - Shared TypeScript configuration
  - `@repo/hono-helpers` - Hono framework utilities
  - `@repo/tools` - Development tools and scripts
- Worker apps delegate scripts to `@repo/tools` for consistency
- Hono web framework with helpers in `@repo/hono-helpers`
- Vitest with `@cloudflare/vitest-pool-workers` for testing
- Syncpack ensures dependency version consistency
- Turborepo enables parallel task execution and caching
- Workers configured via `wrangler.jsonc` with environment variables
- Each worker has `context.ts` for typed environment bindings
- Integration tests in `src/test/integration/`
- Workers use `nodejs_compat` compatibility flag
- GitHub Actions deploy automatically on merge to main
- Changesets manage versions and changelogs
</architecture>

<code-style>
- Use tabs for indentation, spaces for alignment
- Type imports use `import type`
- Workspace imports use `@repo/` prefix
- Import order: Built-ins → Third-party → `@repo/` → Relative
- Prefix unused variables with `_`
- Prefer `const` over `let`
- Use `array-simple` notation
- Explicit function return types are optional
- Prefer functional patterns over imperative
- Use `ts-pattern` for branching instead of switch statements
- Use `neverthrow` for error handling
- Prefer immutability where possible
- Use early returns for error conditions
- Named exports preferred over default exports
- Always check if file exists before creating it
</code-style>

<critical-notes>
- TypeScript configs MUST use fully qualified paths: `@repo/typescript-config/base.json` not `./base.json`
- Do NOT add 'WebWorker' to TypeScript config - types are in worker-configuration.d.ts or @cloudflare/workers-types
- For lint checking: First `cd` to the package directory, then run `bun turbo check:types check:lint`
- Use `workspace:*` protocol for internal dependencies
- Use `bun turbo -F` for build/test/deploy tasks
- Use `pnpm -F` for dependency management (pnpm is still used for package management)
- Commands delegate to `bun runx` which provides context-aware behavior
- Test commands use `bun vitest` directly, not through turbo
- NEVER create files unless absolutely necessary
- ALWAYS prefer editing existing files over creating new ones
- NEVER proactively create documentation files unless explicitly requested
- When editing files, preserve existing indentation and code style
- For worker-api implementations, default to Hono routing, keep shared app/domain types in `src/types.ts`, and use `neverthrow` to propagate errors across RPC and HTTP boundaries
</critical-notes>

<context-specific-rules>
- When user asks to auto commit changes: Read @.cursor/rules/auto-commit.mdc
- When working with Zod: Read @.cursor/rules/zod-v4.mdc
</context-specific-rules>

<technical-patterns>
- Use `ts-pattern` instead of `switch` statements for branching logic
  ```typescript
  import { match } from 'ts-pattern'

  const result = match(error)
    .with({ type: 'NetworkError' }, () => 'Retry')
    .with({ type: 'AuthError' }, () => 'Login')
    .exhaustive()
  ```

- Use `neverthrow` for error handling
  ```typescript
  import { Ok, Err, Result } from 'neverthrow'

  const result: Result<string, Error> = tryParse(input)

  if (result.isOk()) {
    // Success
  } else {
    // Error
  }
  ```

- Use type-safe approaches while avoiding over-engineered types
  - Prefer concrete types over complex generic abstractions
  - Use intersection types carefully
  - Leverage TypeScript's type inference where possible
  - Use discriminated unions for better type safety
</technical-patterns>

</cloudflare-workers-monorepo>
