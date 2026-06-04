/**
 * Point git at our committed hooks (.githooks/) on `npm install`. Dep-free
 * alternative to husky. Wrapped in try/catch so a non-git install context
 * (e.g. a tarball, or a build image without git) never fails the install.
 */
import { execSync } from 'node:child_process';

try {
  execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore' });
  execSync('git config core.hooksPath .githooks', { stdio: 'ignore' });
} catch {
  // Not a git checkout — nothing to wire up.
}
