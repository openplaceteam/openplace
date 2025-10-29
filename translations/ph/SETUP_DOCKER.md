# OpenPlace — Gabay para sa Docker Installation

Ang gabay na ito ay makatutulong para magsetup ng **openplace** sa Docker.

## Prerequisites

Kailangan mag-install ng **Docker** at **Docker Compose** sa inyong kompyuter.

### Install Docker

-   **Windows**: I-download ang Docker Desktop sa [docker.com](https://www.docker.com/products/docker-desktop/)
-   **macOS**: I-download ang Docker Desktop sa [docker.com](https://www.docker.com/products/docker-desktop/)
-   **Linux**: Sundin ang installation guide sa inyong distribution sa [docs.docker.com](https://docs.docker.com/engine/install/)

## 1. I-clone ang repository

```bash
git clone --recurse-submodules https://github.com/openplaceteam/openplace
cd openplace
```

## 2. I-configure ang environment

1.  `.env.example` to `.env`:

```bash
cp .env.example .env
```

2. Edit `.env` file and configure your settings:
    - Set your `JWT_SECRET` (generate a secure random string)
    - Set your `DATABASE_URL` to `"mysql://root:password@db/openplace"`
    - The MariaDB root password is set to `password` (change if needed)

> [WARNING ⚠️]
> Escape special characters listed in this table: [Percent-Encoding](https://developer.mozilla.org/en-US/docs/Glossary/Percent-encoding)

## 3. Isimula ang application

I-run ang buong stack kasama ang Docker Compose:

```bash
docker-compose up -d
```

Magsisimula na ito ng :

-   **MariaDB database** on port 3306
-   **Node.js application** (backend)
-   **Caddy reverse proxy** on port 443

## 4. Mag-access sa application

Kapag nagsisimula ang lahat ng serbisyo, maaring i-access ang OpenPlace sa:

```
http://localhost
https://localhost
```
