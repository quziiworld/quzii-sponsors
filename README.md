# Quzii Sponsors Web App

## Branches
- main = production (matches live Apps Script deployment)
- dev = integration (PRs land here first)

## Deploy
1) Merge dev -> main on GitHub
2) On your machine:
   git checkout main
   git pull
   clasp push
3) In Apps Script: Deploy -> Manage deployments -> update Production

## Test
- Use separate 'Test' deployment + a copy of the Sheet (different SHEET_ID in Script Properties).

