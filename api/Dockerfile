FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies (including dev for build)
RUN npm ci

# Copy source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Remove devDependencies after build
RUN npm prune --omit=dev

# Expose port
EXPOSE 3000

# Start server
CMD ["npm", "start"]
