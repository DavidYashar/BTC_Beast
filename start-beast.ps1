Set-Location C:\Users\yasha\vsCode\utxo-beast
$env:OPENAI_API_KEY = (Get-Content .env | Where-Object { $_ -match '^OPENAI_API_KEY=' } | ForEach-Object { $_ -replace '^OPENAI_API_KEY=','' })
node_modules\.bin\tsx src/index.ts 2>&1 | Tee-Object -FilePath C:\Users\yasha\vsCode\utxo-beast\beast.log
