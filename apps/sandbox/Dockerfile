FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/root
ENV PATH=/usr/local/bin:${PATH}

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
	bash \
	ca-certificates \
	ffmpeg \
	git \
	&& rm -rf /var/lib/apt/lists/*

RUN npm install --global opencode-ai || npm install --global opencode
RUN command -v opencode && opencode --version
RUN mkdir -p "$HOME/.config/opencode" \
	&& printf '%s\n' \
	'{' \
	'  "$schema": "https://opencode.ai/config.json",' \
	'  "provider": {' \
	'    "zai": {' \
	'      "npm": "@ai-sdk/openai-compatible",' \
	'      "name": "Z.AI Coding Plan",' \
	'      "options": {' \
	'        "baseURL": "https://api.z.ai/api/coding/paas/v4",' \
	'        "apiKey": "{env:ZAI_API_KEY}"' \
	'      },' \
	'      "models": {' \
	'        "glm-4.7": { "name": "GLM-4.7" }' \
	'      }' \
	'    }' \
	'  },' \
	'  "model": "zai/glm-4.7"' \
	'}' \
	> "$HOME/.config/opencode/opencode.json"

WORKDIR /workspace
EXPOSE 4096

ENTRYPOINT ["opencode", "serve"]
CMD ["--hostname", "0.0.0.0", "--port", "4096", "--print-logs"]
