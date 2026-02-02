# Asteria Studio — Design System & Style Guide

## Overview

This design system ensures consistency, accessibility, and quality across the Asteria Studio desktop application. All tokens and components follow WCAG 2.2 Level AA guidelines and desktop usability best practices.

## Design Tokens

Tokens are defined in `src/renderer/theme/tokens.ts` and applied via CSS custom properties in `styles.css`.

### Spacing Scale (4px base grid)

```text
xs:  4px   - Icon-to-label gaps, tight padding
sm:  8px   - Compact component padding, small gaps
md:  12px  - Default component padding
lg:  16px  - Section padding, card padding
xl:  24px  - Large section padding, page margins
2xl: 32px  - Hero sections, major spacing
3xl: 48px  - Empty states, page-level padding
4xl: 64px  - Landing sections, onboarding
```

**Usage**:

```css
padding: var(--spacing-md); /* 12px */
gap: var(--spacing-sm); /* 8px */
```

### Typography

**Font families**:

- Sans-serif: `"Inter", system-ui, -apple-system, sans-serif`
- Monospace: `"Fira Code", "SF Mono", Consolas, monospace`

**Font sizes**:

```text
xs:   11px  - Labels, badges, keyboard shortcuts
sm:   12px  - Secondary text, captions
base: 14px  - Body text, UI controls
lg:   16px  - Card titles, section headers
xl:   18px  - Subsection headings
2xl:  24px  - Page titles
3xl:  32px  - Hero headings
```

**Font weights**:

```text
normal:   400  - Body text
medium:   500  - UI controls, emphasis
semibold: 600  - Headings, active states
bold:     700  - Strong emphasis
```

**Line heights**:

```text
tight:   1.25  - Headings, compact UI
normal:  1.5   - Body text (default)
relaxed: 1.75  - Long-form content
```

### Colors

**Light theme**:

```css
--bg-primary: #ffffff /* Main background */ --bg-surface: #f9fafb /* Cards, panels */
  --bg-surface-hover: #f3f4f6 /* Hover states */ --bg-surface-active: #e5e7eb /* Active/pressed */
  --border: #d1d5db /* Primary borders */ --border-subtle: #e5e7eb /* Dividers, subtle borders */
  --text-primary: #111827 /* Headings, body */ --text-secondary: #6b7280 /* Descriptions, labels */
  --text-tertiary: #9ca3af /* Disabled, hints */ --text-inverse: #ffffff /* Text on dark bg */
  --color-primary: #3b82f6 /* Primary actions */ --color-primary-hover: #2563eb /* Primary hover */
  --color-primary-text: #ffffff /* Text on primary */ /* Status colors */ --color-success: #10b981
  --color-success-bg: #d1fae5 --color-success-text: #065f46 --color-warning: #f59e0b
  --color-warning-bg: #fef3c7 --color-warning-text: #92400e --color-error: #ef4444
  --color-error-bg: #fee2e2 --color-error-text: #991b1b --color-info: #3b82f6
  --color-info-bg: #dbeafe --color-info-text: #1e40af;
```

**Dark theme**: Automatically applied via `data-theme="dark"` attribute on `<html>`.

**Overlay colors** (for review annotations):

```text
Page bounds:     #3b82f6 (blue)
Content box:     #10b981 (green)
Text blocks:     #f59e0b (amber)
Ornaments:       #8b5cf6 (purple)
Running heads:   #ec4899 (pink)
Folios:          #06b6d4 (cyan)
Gutter:          #ef4444 (red)
```

### Border Radius

```text
none: 0
sm:   4px  - Input focus, tight corners
md:   6px  - Buttons, inputs, badges (default)
lg:   8px  - Cards, panels
xl:   12px - Modals, large containers
full: 9999px - Pills, round buttons
```

### Shadows

```css
sm:  0 1px 2px rgba(0, 0, 0, 0.05)      /* Subtle elevation */
md:  0 4px 6px rgba(0, 0, 0, 0.07)      /* Cards, dropdowns */
lg:  0 10px 15px rgba(0, 0, 0, 0.1)     /* Modals, popovers */
xl:  0 20px 25px rgba(0, 0, 0, 0.1)     /* Command palette, overlays */
focus: 0 0 0 3px rgba(59, 130, 246, 0.5) /* Focus ring */
```

### Transitions

```css
fast: 150ms cubic-bezier(0.4, 0, 0.2, 1)  /* Hover states */
base: 200ms cubic-bezier(0.4, 0, 0.2, 1)  /* Default (buttons, inputs) */
slow: 300ms cubic-bezier(0.4, 0, 0.2, 1)  /* Slide-ins, complex */
```

**Note**: Respect `prefers-reduced-motion` — set to `0.01ms` if user prefers reduced motion.

### Z-Index Layers

```text
base:     0     - Default stacking
dropdown: 1000  - Dropdowns, selects
sticky:   1100  - Sticky headers
overlay:  1200  - Backdrop overlays
modal:    1300  - Modals, dialogs
popover:  1400  - Popovers, tooltips
tooltip:  1500  - Tooltips (topmost)
```

## Component Patterns

### Buttons

**Variants**:

```html
<button class="btn btn-primary">Primary Action</button>
<button class="btn btn-secondary">Secondary</button>
<button class="btn btn-ghost">Ghost</button>
```

**Sizes**:

```html
<button class="btn btn-sm">Small</button>
<button class="btn">Default</button>
<button class="btn btn-lg">Large</button>
```

**States**:

- `:hover` — Slightly darker background
- `:focus-visible` — Blue outline, 2px offset
- `:disabled` — 50% opacity, no pointer

**Accessibility**:

- Always use semantic `<button>` (not `<div>` with click handler)
- Include aria-label for icon-only buttons
- Disabled buttons should have `aria-disabled="true"`

### Inputs

```html
<label>
  <span>Field Label</span>
  <input class="input" type="text" placeholder="Placeholder" />
</label>
```

**States**:

- `:hover` — Border changes to primary color
- `:focus` — Border + 3px focus ring
- `:disabled` — 50% opacity, no interaction

**Accessibility**:

- Never use placeholder as label
- Associate labels with `for` attribute or wrap input
- Mark required fields with `aria-required="true"`

### Cards

```html
<div class="card">
  <h3 class="card-title">Card Title</h3>
  <p>Card content goes here.</p>
</div>
```

**Usage**: Group related content, project summaries, settings panels.

### Badges (Status)

```html
<span class="badge badge-success">Success</span>
<span class="badge badge-warning">Warning</span>
<span class="badge badge-error">Error</span>
<span class="badge badge-info">Info</span>
```

**Usage**: Run status, confidence indicators, review decisions.

### Empty States

```html
<div class="empty-state">
  <div class="empty-state-icon">📚</div>
  <h2 class="empty-state-title">No items</h2>
  <p class="empty-state-description">Description of what goes here and how to get started.</p>
  <button class="btn btn-primary">Primary Action</button>
</div>
```

**Usage**: Projects, runs, review queue when empty.

## Layout Patterns

### App Shell

```html
<div class="app-layout">
  <nav class="app-nav"><!-- Navigation --></nav>
  <div class="app-main">
    <header class="app-header"><!-- Header --></header>
    <main class="app-content"><!-- Content --></main>
  </div>
</div>
```

**Structure**:

- `app-layout`: Flex container, full height
- `app-nav`: Fixed width (240px), sidebar
- `app-main`: Flex-1, scrollable content area
- `app-header`: Fixed height (48px), top bar
- `app-content`: Scrollable, padded content

### Two-Column (Review Queue)

```css
.review-layout {
  display: flex;
  height: 100%;
}

.review-sidebar {
  width: 300px;
  border-right: 1px solid var(--border);
  overflow-y: auto;
}

.review-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

## Accessibility Guidelines

### Focus Management

**Visible focus**:

```css
:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
  border-radius: 4px;
}
```

**Never**:

- Hide focus outlines (`outline: none` without alternative)
- Rely on color alone for focus indication

**Always**:

- Ensure focus is visible on all interactive elements
- Use `:focus-visible` (not `:focus`) to avoid mouse-click outlines
- Return focus to trigger when closing modals

### Keyboard Navigation

**Tab order**:

- Logical, left-to-right, top-to-bottom
- Skip hidden/disabled elements
- Use `tabindex="0"` for custom interactive elements
- Use `tabindex="-1"` to remove from tab order (but still focusable programmatically)

**Custom controls**:

- Button-like `<div>`: Add `role="button"` and `tabindex="0"`
- Handle Enter and Space key presses
- Use semantic HTML where possible (`<button>`, `<a>`)

### ARIA Labels

**Icon-only buttons**:

```html
<button aria-label="Delete project">
  <span aria-hidden="true">🗑️</span>
</button>
```

**Form inputs**:

```html
<label for="project-name">Project Name</label>
<input id="project-name" type="text" required aria-required="true" />
```

**Live regions** (for progress updates):

```html
<div role="status" aria-live="polite" aria-atomic="true">Processing page 42 of 783...</div>
```

### Color Contrast

**Minimum ratios** (WCAG AA):

- Normal text (<18px): 4.5:1
- Large text (≥18px or ≥14px bold): 3:1
- UI components: 3:1

**Testing**: Use browser DevTools or online contrast checkers.

## Responsive Behavior

**Breakpoints** (if needed for future responsive layouts):

```css
/* Tablets */
@media (max-width: 1024px) {
}

/* Small laptops */
@media (max-width: 1280px) {
}
```

**Current design**: Desktop-first (13"+ screens), not mobile-optimized.

## Component Checklist

When creating new components:

- [ ] Semantic HTML used where possible
- [ ] Focus visible and logical tab order
- [ ] ARIA labels for non-text elements
- [ ] Hover/focus/active states defined
- [ ] Disabled state has reduced opacity + no interaction
- [ ] Color contrast meets WCAG AA
- [ ] Respects `prefers-reduced-motion`
- [ ] Keyboard shortcuts documented (if applicable)
- [ ] Empty/loading/error states handled

## Visual Quality Standards

**Typography**:

- Use system font rendering (`-webkit-font-smoothing: antialiased`)
- Minimum body text size: 14px
- Minimum UI text size: 12px
- Minimum clickable target: 32x32px (44x44px for touch)

**Spacing**:

- Use 4px grid for all spacing
- Consistent padding within component types
- Use whitespace to create visual hierarchy

**Consistency**:

- One vocabulary (no synonyms for same action)
- One layout pattern per screen type
- One interaction model (don't mix paradigms)

## Performance Considerations

**Image loading**:

- Use progressive loading (low-res → high-res)
- Lazy-load offscreen images
- Provide width/height to prevent layout shift

**Large lists**:

- Virtualize (only render visible items)
- Use `react-window` or similar for >100 items

**Animations**:

- Keep under 16ms (60 FPS)
- Use `transform` and `opacity` (GPU-accelerated)
- Avoid animating `width`, `height`, `top`, `left` (triggers layout)

## Theming

**How to toggle**:

```typescript
import { useTheme } from "./hooks/useTheme";

const [theme, setTheme] = useTheme();

// Toggle
setTheme(theme === "light" ? "dark" : "light");
```

**System applies**:

- Sets `data-theme="light"` or `data-theme="dark"` on `<html>`
- Swaps CSS custom properties
- Persists choice in `localStorage`
- Respects `prefers-color-scheme` on first visit

## Design Resources

**Inspiration**:

- [Linear](https://linear.app) — Clean, keyboard-first UI
- [Figma](https://figma.com) — Design tools, inspector panels
- [VS Code](https://code.visualstudio.com) — Command palette, settings
- [Lightroom](https://adobe.com/lightroom) — Image review workflows

**Tools**:

- Contrast checker: [WebAIM](https://webaim.org/resources/contrastchecker/)
- Color palette: [Tailwind Colors](https://tailwindcss.com/docs/customizing-colors)
- Icon library: Use Unicode emoji for MVP (replace with icon font later)

## Migration Path

**Phase 1** (MVP):

- Basic tokens + utility classes
- Core components (Button, Input, Card, Badge)
- Light/dark theme support
- Keyboard shortcuts

**Phase 2** (Enhancement):

- Icon font/SVG library
- Advanced components (Dropdown, Tooltip, Modal)
- Storybook for component docs
- Visual regression tests

**Phase 3** (Polish):

- Motion design system
- Custom focus indicators per component
- Advanced virtualization for 10k+ item lists
- Performance profiling & optimization
