# StaffDesk – Full-Stack Deployment on AWS (EC2 + ECR + RDS + S3 + CloudFront)

## Architecture / flow

```
User (HTTPS)
   │
   ▼
CloudFront  (xxxx.cloudfront.net, HTTPS, redirect HTTP→HTTPS)
   ├── Default (*)   → Origin 1: S3 bucket (React build, private, via OAC)
   └── /api/*        → Origin 2: EC2 public DNS : 5000 (Docker container from ECR)
                                         │
                                         ▼
                               RDS PostgreSQL (private, port 5432 only from EC2 SG)
```

Why `/api/*` goes through CloudFront: the page is served over HTTPS, so the browser blocks calls to a plain
`http://EC2:5000` API (mixed content). With a second origin, the browser only talks to ONE HTTPS domain,
so there is no CORS problem and no extra certificate is needed.

Region used below: `ap-south-1` (Mumbai). Replace `<ACCOUNT_ID>` with your 12-digit AWS account ID.

---------------------------------------------------------------------------------------------------

## STEP 1 – Run locally

Requirements: Node 20+, Docker.

```bash
# Terminal 1 - backend + postgres
docker compose up --build
curl http://localhost:5000/api/health        # {"status":"ok","db":"connected"}

# Terminal 2 - frontend
cd frontend && npm install && npm run dev    # http://localhost:5173
```
Login: `admin@staffdesk.com` / `Admin@123` → add, edit, search, delete staff.
Open browser DevTools → Network: calls go to `/api/...` (proxied by Vite) and return 200.

## STEP 2 – Build the backend Docker image

```bash
cd backend
docker build -t staffdesk-backend .
```

## STEP 3 – Security groups (EC2 console → Security Groups)

| SG name | Inbound rule | Source |
|---|---|---|
| `staffdesk-ec2-sg` | SSH 22 | My IP |
| `staffdesk-ec2-sg` | Custom TCP 5000 | Managed prefix list `com.amazonaws.global.cloudfront.origin-facing` (only CloudFront can reach the API). For first testing you may temporarily use 0.0.0.0/0 |
| `staffdesk-rds-sg` | PostgreSQL 5432 | Source = `staffdesk-ec2-sg` (security group, NOT an IP) |

> The CloudFront prefix list counts as ~55 rules; it fits within the default 60 rules/SG limit.

## STEP 4 – Create RDS PostgreSQL

RDS → Create database → Standard create
- Engine: PostgreSQL 15/16, Template: **Free tier / Dev-Test**
- DB instance identifier: `staffdesk-db`
- Master username: `postgres`, set a strong password
- Instance: `db.t3.micro`, Storage 20 GB
- Connectivity: default VPC, **Public access = No**, VPC SG = `staffdesk-rds-sg`
- Additional configuration → **Initial database name: `staffdesk`**
- Create, then copy the **Endpoint** (e.g. `staffdesk-db.xxxx.ap-south-1.rds.amazonaws.com`).

The app creates its tables and the admin user automatically on first start.
(RDS PostgreSQL 15+ forces SSL → the app uses `DB_SSL=true`.)

## STEP 5 – Push the image to Amazon ECR

```bash
aws ecr create-repository --repository-name staffdesk-backend --region ap-south-1

aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com

docker tag staffdesk-backend:latest <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/staffdesk-backend:latest
docker push <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/staffdesk-backend:latest
```
If you build on an Apple-silicon Mac, build with `docker build --platform linux/amd64 ...`.

## STEP 6 – Launch the EC2 backend server

1. IAM → Roles → create `staffdesk-ec2-role` (trusted entity: EC2) with policy
   `AmazonEC2ContainerRegistryReadOnly`.
2. EC2 → Launch instance: **Amazon Linux 2023**, `t3.micro`, key pair, SG `staffdesk-ec2-sg`,
   Auto-assign public IP = Enable, IAM instance profile = `staffdesk-ec2-role`.
3. SSH in and install Docker:

```bash
ssh -i key.pem ec2-user@<EC2_PUBLIC_IP>
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user && exit      # log in again
```

4. Create the environment file (`~/staffdesk.env`):

```bash
cat > ~/staffdesk.env <<'ENV'
PORT=5000
DB_HOST=<RDS_ENDPOINT>
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=<YOUR_DB_PASSWORD>
DB_NAME=staffdesk
DB_SSL=true
JWT_SECRET=<RANDOM_LONG_STRING>
CORS_ORIGIN=*
ADMIN_EMAIL=admin@staffdesk.com
ADMIN_PASSWORD=Admin@123
ENV
chmod 600 ~/staffdesk.env
```

5. Pull and run:

```bash
aws ecr get-login-password --region ap-south-1 | \
  docker login --username AWS --password-stdin <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com

docker run -d --name staffdesk-backend --restart unless-stopped \
  -p 5000:5000 --env-file ~/staffdesk.env \
  <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/staffdesk-backend:latest

docker logs -f staffdesk-backend      # expect "Database ready" and "API listening on 5000"
```

## STEP 7 – Verify the backend

```bash
curl http://<EC2_PUBLIC_DNS>:5000/api/health
curl -X POST http://<EC2_PUBLIC_DNS>:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@staffdesk.com","password":"Admin@123"}'      # returns a JWT token
```
Note the **EC2 Public IPv4 DNS** (`ec2-x-x-x-x.ap-south-1.compute.amazonaws.com`). CloudFront needs a DNS name, not an IP.

## STEP 8 – Build and upload the frontend to S3

```bash
aws s3 mb s3://staffdesk-frontend-<UNIQUE_SUFFIX> --region ap-south-1   # keep "Block all public access" ON

cd frontend
cp .env.example .env            # VITE_API_URL stays EMPTY → calls /api on the CloudFront domain
npm install && npm run build
aws s3 sync dist/ s3://staffdesk-frontend-<UNIQUE_SUFFIX> --delete
```

## STEP 9 – Create the CloudFront distribution

CloudFront → Create distribution

**Origin 1 – S3 (frontend)**
- Origin domain: your S3 bucket (choose the bucket, not the website endpoint)
- Origin access: **Origin access control (OAC)** → Create new OAC (Sign requests)
- Default root object: `index.html`

**Default behavior**
- Viewer protocol policy: **Redirect HTTP to HTTPS**
- Allowed methods: GET, HEAD
- Cache policy: **CachingOptimized**
- Compress objects: Yes

Create the distribution, then:
1. Copy the **bucket policy** CloudFront offers ("Copy policy") → S3 bucket → Permissions → Bucket policy → paste & save.

**Origin 2 – Backend (Origins tab → Create origin)**
- Origin domain: `ec2-x-x-x-x.ap-south-1.compute.amazonaws.com`
- Protocol: **HTTP only**, HTTP port **5000**
- Name: `staffdesk-api`

**Behavior for the API (Behaviors tab → Create behavior)**
- Path pattern: `/api/*`
- Origin: `staffdesk-api`
- Viewer protocol policy: **HTTPS only** (or Redirect HTTP to HTTPS)
- Allowed HTTP methods: **GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE**
- Cache policy: **CachingDisabled**
- Origin request policy: **AllViewerExceptHostHeader** (forwards Authorization header, query strings, cookies)
- Response headers policy (optional CORS): **CORS-With-Preflight**

**SPA routing (Error pages tab)**
- Create custom error response: HTTP error code **403** → Response page path `/index.html` → HTTP response code **200**.
  (S3 with OAC returns 403 for unknown paths. Do not map 404, or backend "not found" JSON would be replaced.)

**HTTPS / certificate**
- Default `*.cloudfront.net` certificate is HTTPS-enabled automatically (nothing to do).
- Custom domain (optional): request an ACM public certificate in **us-east-1**, add the domain as an
  Alternate domain name (CNAME) on the distribution, select the certificate, and create a Route 53 alias record.
- Security policy: TLSv1.2_2021. HTTP versions: HTTP/2 and HTTP/3.

Wait until Status = **Deployed** (3–10 min). Your URL: `https://<DISTRIBUTION_ID>.cloudfront.net`

## STEP 10 – Lock down CORS (final hardening)

Same-origin through CloudFront needs no CORS, but set the backend to only accept your domain:

```bash
docker rm -f staffdesk-backend
sed -i 's|^CORS_ORIGIN=.*|CORS_ORIGIN=https://<DISTRIBUTION_ID>.cloudfront.net|' ~/staffdesk.env
docker run -d --name staffdesk-backend --restart unless-stopped -p 5000:5000 \
  --env-file ~/staffdesk.env <ACCOUNT_ID>.dkr.ecr.ap-south-1.amazonaws.com/staffdesk-backend:latest
```
Then restrict the EC2 SG port 5000 rule to the CloudFront prefix list (if you used 0.0.0.0/0 earlier).

## STEP 11 – Test and verify

| Test | Command / action | Expected |
|---|---|---|
| Frontend via CloudFront | open `https://<DIST>.cloudfront.net` | Login page loads, padlock shown |
| HTTP→HTTPS | `curl -I http://<DIST>.cloudfront.net` | 301 → https |
| API via CloudFront | `curl https://<DIST>.cloudfront.net/api/health` | `{"status":"ok","db":"connected"}` |
| Login | UI login admin@staffdesk.com / Admin@123 | Dashboard opens |
| CRUD | add / edit / search / delete staff | Rows persist after refresh (data in RDS) |
| Auth guard | `curl https://<DIST>.cloudfront.net/api/staff` | 401 Unauthorized |
| Console / Network | DevTools → F12 | No CORS or mixed-content errors; `/api/*` = 200 |
| CloudFront status | Console → Distribution | Status Deployed, Enabled |
| Cache behavior | `curl -I https://<DIST>.cloudfront.net/` | `X-Cache: Hit from cloudfront` on 2nd request; `/api/*` shows `Miss` (never cached) |

Redeploying the frontend later:
```bash
npm run build && aws s3 sync dist/ s3://<BUCKET> --delete
aws cloudfront create-invalidation --distribution-id <DIST_ID> --paths "/*"
```

## STEP 12 – Troubleshooting log (document what you hit)

| Symptom | Cause | Fix |
|---|---|---|
| Backend container exits, `no pg_hba.conf entry ... no encryption` | RDS requires SSL | `DB_SSL=true` |
| `ETIMEDOUT` to RDS | RDS SG doesn't allow EC2 SG | Add 5432 inbound from `staffdesk-ec2-sg` |
| `database "staffdesk" does not exist` | Initial DB name not set | Create via `psql` or recreate with the name |
| CloudFront `504` on `/api/*` | EC2 SG blocks 5000 / wrong origin port | Allow CloudFront prefix list on 5000; origin = HTTP only, port 5000 |
| CloudFront `502` | Origin is an IP / HTTPS-only | Use public DNS name; protocol HTTP only |
| Login returns 401 via CloudFront only | Authorization header not forwarded | Origin request policy `AllViewerExceptHostHeader` |
| `/api` returns HTML (index.html) | API behavior missing or wrong path pattern | Pattern must be `/api/*` with backend origin |
| S3 `AccessDenied` on page | Bucket policy for OAC not applied | Paste the policy CloudFront generated |
| Blank page / old JS after redeploy | CDN cache | Invalidate `/*` |
| Mixed content error | Frontend built with `VITE_API_URL=http://...` | Leave `VITE_API_URL` empty and rebuild |

## Deliverables checklist (screenshots to capture)

1. RDS instance details + endpoint, and RDS security group inbound rules
2. ECR repository with the pushed image tag
3. EC2 instance (running), its security group inbound rules, `docker ps` output
4. `curl .../api/health` output from EC2
5. S3 bucket objects (index.html, assets/) and bucket policy
6. CloudFront: General tab (domain name, status Deployed), Origins tab, Behaviors tab, Error pages tab
7. Browser: app at CloudFront URL (login + staff list) and DevTools Network showing `/api/*` = 200
8. This architecture diagram (above) as your AWS deployment flow
