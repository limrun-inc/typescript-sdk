import { loadEnvFile } from 'node:process';

// Load before config dependencies evaluate, preserving values supplied by the shell.
try {
  loadEnvFile(process.env['DOTENV_CONFIG_PATH']);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw error;
  }
}
