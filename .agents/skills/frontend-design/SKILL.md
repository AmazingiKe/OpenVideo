---
name: frontend-design
description: Build or review OpenVideo web interfaces that must follow the project design system, reuse existing components, and meet responsive, accessibility, dark-mode, and visual-quality requirements.
---

# Frontend Design

Create professional SaaS/tool interfaces with deliberate information hierarchy and minimal visual noise. Preserve the existing React/Vite stack and established product patterns.

## Discover before building

1. Inspect nearby feature and shared components for an existing solution.
2. Run `pnpm --dir apps/web exec shadcn info --json`, then search installed Storybook documentation and the shadcn registry before creating UI.
3. Prefer existing project components, then shadcn/Radix composition. Use Motion Primitives, Magic UI, or Aceternity only when they solve a real interaction or presentation need without weakening accessibility or consistency.
4. Extract repeated UI or behavior into one reusable component with a clear API. Do not retain duplicate implementations or compatibility aliases.

## Design system

- Use semantic design tokens for color, typography, radius, elevation, spacing, and motion. Never scatter raw color or spacing values through components.
- Use an 8 px spatial grid. A 4 px half-step is allowed only for compact internal alignment when represented by an existing token.
- Establish typography roles for page title, section title, body, label, metadata, and code/data. Do not choose sizes independently per component.
- Make the primary task and status visually dominant; keep secondary actions and metadata quieter. Avoid decorative effects that compete with tool content.
- Use Lucide icons consistently. Icons support labels and affordances; they do not replace unclear text.

## Product quality

- Design responsive behavior for narrow, medium, and wide layouts. Reflow or collapse dense tool panels instead of merely shrinking them.
- Use semantic HTML, keyboard access, visible focus, correctly associated labels, appropriate ARIA, and sufficient contrast. Validate interactive and error states.
- Support light and dark themes through semantic tokens. Verify hover, focus, selected, disabled, loading, empty, success, warning, and error states in both themes.
- Prefer CSS transitions for simple feedback. Use Motion for stateful or spatial transitions, respect reduced-motion preferences, and avoid gratuitous animation.
- Add or update Storybook stories for reusable components, including meaningful variants and edge states. Run Storybook interaction/accessibility tests when applicable.

## Verification

Run lint, typecheck, unit tests, production build, and Storybook build. Visually inspect representative responsive widths and both color schemes for material UI changes.
