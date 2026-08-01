import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readProjectFile(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function readProjectJson(relativePath) {
  return JSON.parse(readProjectFile(relativePath));
}

function readCargoPackageVersion() {
  const cargoToml = readProjectFile('src-tauri/Cargo.toml');
  let inPackageSection = false;

  for (const line of cargoToml.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (/^\[[^\]]+\]$/.test(trimmedLine)) {
      if (inPackageSection) break;
      inPackageSection = trimmedLine === '[package]';
      continue;
    }

    if (inPackageSection) {
      const version = trimmedLine.match(/^version\s*=\s*"([^"]+)"/);
      if (version) return version[1];
    }
  }

  throw new Error('Could not find package.version in src-tauri/Cargo.toml');
}

test('Tauri runs the frontend development and production build commands', () => {
  const tauriConfig = readProjectJson('src-tauri/tauri.conf.json');

  assert.equal(tauriConfig.build.beforeDevCommand, 'npm run dev');
  assert.equal(tauriConfig.build.beforeBuildCommand, 'npm run build');
});

test('package, Cargo, and Tauri versions remain aligned', () => {
  const packageJson = readProjectJson('package.json');
  const tauriConfig = readProjectJson('src-tauri/tauri.conf.json');
  const cargoVersion = readCargoPackageVersion();

  assert.equal(cargoVersion, packageJson.version);
  assert.equal(tauriConfig.version, packageJson.version);
});

test('Tauri file associations remain limited to Markdown and text documents', () => {
  const tauriConfig = readProjectJson('src-tauri/tauri.conf.json');
  const associatedExtensions = tauriConfig.bundle.fileAssociations
    .flatMap(association => association.ext);

  assert.deepEqual(associatedExtensions, ['md', 'markdown', 'txt']);
  assert.equal(associatedExtensions.includes('tex'), false);
  assert.equal(associatedExtensions.includes('log'), false);
});

test('Tauri capabilities do not grant frontend filesystem access or scopes', () => {
  const capabilities = readProjectJson('src-tauri/capabilities/default.json');
  const filesystemPermissions = capabilities.permissions.filter(permission => {
    const identifier = typeof permission === 'string'
      ? permission
      : permission?.identifier;

    return identifier === 'fs' || identifier?.startsWith('fs:');
  });

  assert.deepEqual(filesystemPermissions, []);
});

test('Tauri grants only the narrow window mutation needed for theme sync', () => {
  const capabilities = readProjectJson('src-tauri/capabilities/default.json');
  const windowMutationPermissions = capabilities.permissions
    .map(permission => typeof permission === 'string' ? permission : permission?.identifier)
    .filter(identifier => identifier?.startsWith('core:window:allow-set-'));

  assert.deepEqual(windowMutationPermissions, ['core:window:allow-set-theme']);
});

test('the package test script uses the Node.js built-in test runner', () => {
  const packageJson = readProjectJson('package.json');
  const packageLock = readProjectJson('package-lock.json');

  assert.equal(packageJson.scripts.test, 'node --test');
  assert.equal(packageJson.engines.node, '>=22');
  assert.deepEqual(packageLock.packages[''].engines, packageJson.engines);
});

test('continuous integration runs frontend and Rust verification', () => {
  const workflow = readProjectFile('.github/workflows/checks.yml');

  assert.match(workflow, /push:\s*\n\s+branches:\s*\n\s+- '\*\*'/);
  assert.match(workflow, /node-version: 24/);

  for (const command of [
    'npm ci',
    'npm test',
    'npm run build',
    'cargo fmt --manifest-path src-tauri/Cargo.toml -- --check',
    'cargo test --manifest-path src-tauri/Cargo.toml --locked',
    'cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings',
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('GitHub Actions use Node 24 compatible action majors', () => {
  const checksWorkflow = readProjectFile('.github/workflows/checks.yml');
  const buildWorkflow = readProjectFile('.github/workflows/build.yml');

  for (const workflow of [checksWorkflow, buildWorkflow]) {
    assert.match(workflow, /actions\/checkout@v6/);
    assert.match(workflow, /actions\/setup-node@v6/);
  }

  assert.match(buildWorkflow, /actions\/upload-artifact@v7/);
  assert.match(buildWorkflow, /actions\/download-artifact@v8/);
});

test('tag releases wait for a reproducible verification gate', () => {
  const workflow = readProjectFile('.github/workflows/build.yml');
  const downloadWindowsAsset = workflow.indexOf('- name: Download Windows assets');
  const createRelease = workflow.indexOf('- name: Create or update GitHub Release');

  assert.match(workflow, /^  verify:\s*$/m);
  assert.match(workflow, /^  build:\s*\n    needs: verify\s*$/m);
  assert.match(workflow, /^  release:\s*\n    needs: \[verify, build\]\s*$/m);
  assert.match(workflow, /node-version: 24/);
  assert.match(workflow, /needs\.verify\.result == 'success'/);
  assert.match(workflow, /expected_tag="v\$\{package_version\}"/);
  assert.match(workflow, /\$0 == heading \|\| index\(\$0, heading " - "\) == 1/);
  assert.doesNotMatch(workflow, /run:\s+npm install(?:\s|$)/);
  assert.ok(downloadWindowsAsset >= 0);
  assert.ok(createRelease > downloadWindowsAsset);

  for (const command of [
    'npm ci',
    'npm test',
    'npm run build',
    'cargo fmt --manifest-path src-tauri/Cargo.toml -- --check',
    'cargo test --manifest-path src-tauri/Cargo.toml --locked',
    'cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings',
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('the browser file input does not hardcode an accept list', () => {
  const html = readProjectFile('index.html');
  const fileInput = html
    .match(/<input\b[^>]*>/gi)
    ?.find(input => /\bid\s*=\s*["']file-input["']/i.test(input));

  assert.ok(fileInput, 'expected index.html to contain #file-input');
  assert.doesNotMatch(fileInput, /\baccept\s*=/i);
});

test('the shared document type policy is valid JSON with unique extensions', () => {
  const rawPolicy = readProjectFile('shared/document-types.json');
  let policy;

  assert.doesNotThrow(() => {
    policy = JSON.parse(rawPolicy);
  });

  const extensions = Object.values(policy.types)
    .flatMap(documentType => documentType.extensions)
    .map(extension => extension.toLowerCase());

  assert.equal(new Set(extensions).size, extensions.length);
});
