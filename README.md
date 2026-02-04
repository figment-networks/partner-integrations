# Figment Recipe Repo

Stake in _minutes_! 

Use this repo to test programmatic staking flows using Figment's API. Directories are segregated by custodial solutions: `dfns`, `fireblocks`, and `prop`. Use `prop` if you have a proprietary custody solution. You can replace hot wallet signing with your own signing infrastructure. 

## Setup
1. If you haven't already, create a Figment API key using [these instructions](https://docs.figment.io/reference/authentication)
2. `cd` into the directory of the custody solution you'll use 
3. `cp .env.example .env` and add your credentials
4. `npm install` 
5. Run the file you want to test using e.g. `node solana.js`