# Panic Selling Austin

Real estate price-drop tracking dashboard for Austin, TX. Scans active listings via the RentCast API, detects price reductions, and ranks them by severity.

**Live**: [glitch46.github.io/panicselling](https://glitch46.github.io/panicselling/)

## Features

- Pulls up to 500 active Austin sale listings from RentCast
- Detects price drops by comparing current price to listing history
- Ranks drops by dollar amount, percentage, recency, or lowest price
- Filters by property type (Single Family, Condo, Townhouse, Multi-Family) and drop threshold (10%+, 20%+)
- 24-hour localStorage cache to stay within API rate limits
- Responsive design (desktop, tablet, mobile)
- Texas-themed dark UI

## Setup

1. Get a free API key at [rentcast.io](https://www.rentcast.io)
2. Open the page and enter your key
3. Data is fetched and cached in your browser — nothing is sent to any server besides RentCast

## Tech

Single `index.html` file. No frameworks, no build tools. HTML + CSS + vanilla JS.

## Inspired by

[panicselling.xyz](https://panicselling.xyz) (Dubai market tracker)
