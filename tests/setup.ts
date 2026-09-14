import path from 'path';

// Xcode clients must not inherit tool preferences from the test runner's home.
process.env['MISE_GLOBAL_CONFIG_FILE'] = path.join(__dirname, 'fixtures', 'empty-mise.toml');
