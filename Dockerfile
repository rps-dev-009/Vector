# Use Node.js 24 (LTS)
FROM node:24-alpine

# Set working directory
WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Copy client package files
COPY client/package.json ./client/

# Install dependencies for both backend and frontend
RUN npm install
RUN cd client && npm install

# Copy source code
COPY . .

# Build the React frontend
RUN npm run build

# Expose Hugging Face Space port
ENV PORT=7860
EXPOSE 7860

# Start the server
CMD ["npm", "start"]
