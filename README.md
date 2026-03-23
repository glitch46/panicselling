Set your RentCast key in `.env` (PowerShell format):

```powershell
$env:RENTCAST_API_KEY=YOUR_RENTCAST_API_KEY
```

Run the sale listings pipeline (one RentCast call + verifier):

```powershell
node scripts/run-listings-pipeline.js
```
