# Contributing

Thanks for taking a look! The project is young so things move around a lot, but
contributions are welcome.

## Setup

```bash
git clone https://github.com/anshitsinha/cellforge.git
cd cellforge
npm install
npm run dev
```

## Workflow

- Branch off `main`. Name branches like `feat/column-resize` or `fix/scroll-jank`.
- Keep PRs small and focused — one thing per PR is much easier to review.
- Run `npm run typecheck` before pushing.

## Commit messages

Loosely following [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(grid): add column resizing
fix(web): formula bar loses focus on enter
docs: explain virtual scroll in architecture notes
```

Not strict about it, just keep the first line short and say *what* changed.

## Code style

- TypeScript, strict mode.
- 2-space indent (see `.editorconfig`).
- Comments should explain *why*, not restate the code.
