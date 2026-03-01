import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [cloudflare(), react()],
	build: {
		outDir: 'public',
		emptyOutDir: true,
	},
});
