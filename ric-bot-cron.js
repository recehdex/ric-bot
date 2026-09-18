'use strict';
const { ethers } = require('ethers');

(async function () {

            "use strict";

            // ==================== KONFIGURASI BRUTAL ====================
            const HARDCODED = {
                rpcUrl: 'wss://seed-richechain.com:8586/',
                chainId: 132026,
                wrappedNative: '0xEa126036c94Ab6A384A25A70e29E2fE2D4a91e68'.toLowerCase(),
                multicallAddress: '0xa24707355a47A3D3Befff53A6a66Db0915645897'.toLowerCase(),
                slippageBps: 0, // SLIPPAGE 0%
                maxSlippageBps: 0, // MAKSIMAL 0%
                gasPriceGwei: 0.1, // GAS SUPER MURAH
                taxHandling: 'auto',
                taxThreshold: 5
            };

            // STATE
            let provider, signer, account, multicall;
            let allPairs = [];
            let pairsByToken = new Map();
            let pairMap = new Map();
            let tokenInfo = new Map();
            let blacklistedTokens = new Map();
            const dexNames = ['dex1', 'dex2', 'dex3'];

            let connectionCheckInterval = null;
            let lastBlockNumber = 0;
            let reconnectAttempts = 0;
            const MAX_RECONNECT_ATTEMPTS = 5;

            let totalCompounded = ethers.BigNumber.from(0);
            let consecutiveLosses = 0;
            const MAX_CONSECUTIVE_LOSSES = 10; // Lebih longgar

            let CONFIG = {
                ...HARDCODED,
                routers: {},
                factories: {},
                gasPriceGwei: 0.1,
                maxHops: 3,
                minLiquidity: 0.001,
                loopDelay: 100,
                NATIVE: HARDCODED.wrappedNative,
                nativeSymbol: 'RIC',
                wrappedSymbol: 'WRIC',
                // SEMUA FILTER PROFIT DINONAKTIFKAN
                minProfitNative: ethers.BigNumber.from(0),
                minProfitAbsolute: ethers.BigNumber.from(0),
                minProfitPercent: 0,
                gasBufferPercent: 0, // TIDAK ADA BUFFER
                gasEstimate2Hop: 204000,
                gasEstimate3Hop: 306000,
                gasEstimate4Hop: 408000,

                // Optimasi pencarian modal:
                // modal wallet = batas maksimum, BUKAN ukuran trade yang wajib dipakai.
                minTradeNative: 0.00001,
                amountSearchRefineSteps: 5,
                amountSearchMaxCandidates: 30,

                // Eksekusi tidak lagi memaksa amountOutMin 100% exact.
                // Buffer kecil mengurangi revert akibat perubahan reserve antar transaksi.
                executionSlippageBps: 5,

                // Tidak ada filter profit arbitrer. Satu-satunya syarat ekonomi
                // adalah net profit setelah estimasi gas harus > 0.
                netProfitBufferBps: 0,

                maxRetries: 3,
                retryDelay: 1000,
                rpcTimeout: 15000,
                reloadAllInterval: 10000
            };

            let botRunning = false;
            let stopRequested = false;
            let reloadTimer = null;
            let isLoadingPairs = false;

            let totalModal = ethers.BigNumber.from(0);
            let totalGas = ethers.BigNumber.from(0);
            let totalProfit = ethers.BigNumber.from(0);
            let totalLoss = ethers.BigNumber.from(0);

            function formatNumber(num) {
                if (num === 0) return '0.000000';
                if (Math.abs(num) < 0.000001) return num.toExponential(6);
                return num.toFixed(6);
            }

            function updateGlobalStats() {
                log(`STATS | modal=${formatEther(totalModal)} WRIC | gas=${formatEther(totalGas)} WRIC | profit=${formatEther(totalProfit)} WRIC | loss=${formatEther(totalLoss)} WRIC`, 'STATS');
            }

            // ABI
            const FACTORY_ABI = ["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"];
            const PAIR_ABI = ["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)"];
            const ERC20_ABI = ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
            const ROUTER_ABI = ["function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)", "function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns ()", "function getAmountsOut(uint amountIn, address[] calldata path) view returns (uint[] memory)"];
            const MULTICALL_ABI = [{ constant: true, inputs: [{ components: [{ internalType: "address", name: "target", type: "address" }, { internalType: "bytes", name: "callData", type: "bytes" }], internalType: "struct Multicall2.Call[]", name: "calls", type: "tuple[]" }], name: "aggregate", outputs: [{ internalType: "uint256", name: "blockNumber", type: "uint256" }, { internalType: "bytes[]", name: "returnData", type: "bytes[]" }], payable: false, stateMutability: "view", type: "function" }];

            function log(msg, type = 'INFO') {
                const timestamp = new Date().toISOString();
                console.log(`[${timestamp}] [${type}] ${msg}`);
            }
            function formatEther(wei) {
                try {
                    if (!wei) return '0';
                    return ethers.utils.formatEther(wei);
                } catch {
                    return '0';
                }
            }

            function parseEther(val) {
                try {
                    return ethers.utils.parseUnits(val.toString(), 18);
                } catch {
                    return ethers.BigNumber.from(0);
                }
            }

            function normalizeToEther(amount, dec) {
                if (!amount) return ethers.BigNumber.from(0);
                if (dec === 18) return amount;
                if (dec < 18) return amount.mul(ethers.BigNumber.from(10).pow(18 - dec));
                return amount.div(ethers.BigNumber.from(10).pow(dec - 18));
            }

            function denormalizeFromEther(amount, dec) {
                if (!amount) return ethers.BigNumber.from(0);
                if (dec === 18) return amount;
                if (dec < 18) return amount.div(ethers.BigNumber.from(10).pow(18 - dec));
                return amount.mul(ethers.BigNumber.from(10).pow(dec - 18));
            }

            function showPopup(msg, type) {
                log(`${type === 'profit' ? '💰' : '💔'} ${msg}`, type === 'profit' ? 'SUCCESS' : 'ERROR');
            }

            async function getWRICBalance() {
                try {
                    const wricContract = new ethers.Contract(CONFIG.NATIVE, ERC20_ABI, provider);
                    return await wricContract.balanceOf(account);
                } catch (e) {
                    return ethers.BigNumber.from(0);
                }
            }

            // ==================== SLIPPAGE 0 ====================
            function calculateDynamicSlippage(amountIn, tokenIn, tokenOut, dex) {
                return 0; // SELALU 0
            }

            function calculateRealSlippage(amountIn, reserveIn, decimalsIn = 18) {
                return 0; // SELALU 0
            }

            // ==================== GAS PRICE FIXED 0.1 GWEI ====================
            async function getCurrentGasPrice() {
                const fixedGas = ethers.utils.parseUnits(CONFIG.gasPriceGwei.toString(), 'gwei');
                return { gasPrice: fixedGas };
            }

            async function getEffectiveGasPrice() {
                return ethers.utils.parseUnits(CONFIG.gasPriceGwei.toString(), 'gwei');
            }

            function addHistoryRecord(data) {
                try {
                    const isProfit = data.status === 'SUKSES' || (data.status !== 'RUGI' && data.profitNum > 0);

                    if (data.modalEth) totalModal = totalModal.add(data.modalEth);
                    if (data.gasCostEth) totalGas = totalGas.add(data.gasCostEth);
                    if (data.profitNum >= 0) totalProfit = totalProfit.add(data.profitEth);
                    else totalLoss = totalLoss.add(ethers.BigNumber.from(0).sub(data.profitEth));
                    updateGlobalStats();

                    log(`📋 HASIL | status=${isProfit ? 'PROFIT' : 'RUGI'} | modal=${formatEther(data.modalEth)} WRIC | profit=${formatEther(data.profitEth)} WRIC | gas=${formatEther(data.gasCostEth || 0)} WRIC | net=${data.netProfit || '0 WRIC'} | hops=${data.hopCount}`, isProfit ? 'SUCCESS' : 'WARN');

                    if (data.status === 'RUGI' || data.profitNum < 0) {
                        consecutiveLosses++;
                        if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
                            log(`⚠️ ${consecutiveLosses} rugi berturut-turut, cooldown 30 detik`, 'WARN');
                            awaitDelay(30000).then(() => {
                                consecutiveLosses = 0;
                                log('✅ Cooldown selesai', 'INFO');
                            }).catch(() => {});
                        }
                    } else {
                        consecutiveLosses = 0;
                    }
                } catch (e) {
                    log('Gagal catat hasil: ' + e.message, 'WARN');
                }
            }

            function awaitDelay(ms) {
                return new Promise(resolve => setTimeout(resolve, ms));
            }

            async function callWithRetry(fn, ctx = '') {
                let lastError;
                for (let i = 0; i < CONFIG.maxRetries; i++) {
                    try {
                        return await Promise.race([
                            fn(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('RPC timeout')), CONFIG.rpcTimeout))
                        ]);
                    } catch (e) {
                        lastError = e;
                        if (i < CONFIG.maxRetries - 1) {
                            await new Promise(r => setTimeout(r, CONFIG.retryDelay * Math.pow(2, i)));
                        }
                    }
                }
                throw lastError;
            }

            async function getTokenInfo(addr) {
                if (tokenInfo.has(addr)) return tokenInfo.get(addr);
                const t = new ethers.Contract(addr, ERC20_ABI, provider);
                let sym = '???', dec = 18;
                try {
                    sym = await callWithRetry(() => t.symbol(), `symbol-${addr}`);
                } catch (e) {}
                try {
                    dec = await callWithRetry(() => t.decimals(), `decimals-${addr}`);
                } catch (e) {}
                const inf = { symbol: sym, decimals: dec };
                tokenInfo.set(addr, inf);
                return inf;
            }

            function checkLiquidity(pair, minVal) {
                if (pair.token0 !== CONFIG.NATIVE && pair.token1 !== CONFIG.NATIVE) return true;
                const nativeReserve = pair.token0 === CONFIG.NATIVE ? pair.reserve0 : pair.reserve1;
                if (nativeReserve.isZero()) return false;
                const norm = normalizeToEther(nativeReserve, 18);
                const val = parseFloat(ethers.utils.formatEther(norm));
                return val >= minVal;
            }

            function getAmountOut(amountIn, tokenIn, tokenOut, dex) {
                try {
                    if (!amountIn || amountIn.isZero()) return ethers.BigNumber.from(0);

                    const key = `${dex}_${tokenIn}_${tokenOut}`;
                    const pair = pairMap.get(key);
                    if (!pair) return ethers.BigNumber.from(0);

                    const tokenInInfo = tokenInfo.get(tokenIn) || { decimals: 18 };
                    const tokenOutInfo = tokenInfo.get(tokenOut) || { decimals: 18 };

                    let reserveIn, reserveOut;
                    if (pair.token0 === tokenIn && pair.token1 === tokenOut) {
                        reserveIn = pair.reserve0;
                        reserveOut = pair.reserve1;
                    } else if (pair.token0 === tokenOut && pair.token1 === tokenIn) {
                        reserveIn = pair.reserve1;
                        reserveOut = pair.reserve0;
                    } else return ethers.BigNumber.from(0);

                    if (reserveIn.isZero() || reserveOut.isZero()) return ethers.BigNumber.from(0);

                    const normReserveIn = normalizeToEther(reserveIn, tokenInInfo.decimals);
                    const normReserveOut = normalizeToEther(reserveOut, tokenOutInfo.decimals);
                    const normAmountIn = normalizeToEther(amountIn, tokenInInfo.decimals);

                    const amountInWithFee = normAmountIn.mul(997);
                    const numerator = amountInWithFee.mul(normReserveOut);
                    const denominator = normReserveIn.mul(1000).add(amountInWithFee);

                    if (denominator.isZero()) return ethers.BigNumber.from(0);

                    const normAmountOut = numerator.div(denominator);
                    return denormalizeFromEther(normAmountOut, tokenOutInfo.decimals);
                } catch (e) {
                    return ethers.BigNumber.from(0);
                }
            }

            async function validateMulticall() {
                try {
                    const code = await provider.getCode(CONFIG.multicallAddress);
                    if (code === '0x' || code === '0x0') {
                        return false;
                    }
                    return true;
                } catch (e) {
                    return false;
                }
            }

            async function loadPairsFromFactory(dexName, factoryAddr) {
                const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
                let count;
                try {
                    count = (await callWithRetry(() => factory.allPairsLength(), `allPairsLength-${dexName}`)).toNumber();
                } catch (e) {
                    log(`Gagal allPairsLength ${dexName}: ${e.message}`, 'ERROR');
                    return;
                }
                if (count === 0) {
                    log(`${dexName}: tidak ada pair`, 'WARN');
                    return;
                }
                log(`📦 Memuat ${count} pair dari ${dexName}...`);

                const BATCH = 100;
                const factoryIface = new ethers.utils.Interface(FACTORY_ABI);
                const pairIface = new ethers.utils.Interface(PAIR_ABI);

                for (let start = 0; start < count; start += BATCH) {
                    const end = Math.min(start + BATCH, count);
                    const indices = Array.from({ length: end - start }, (_, i) => start + i);

                    const callsPairAddr = indices.map(i => ({
                        target: factoryAddr,
                        callData: factoryIface.encodeFunctionData('allPairs', [i])
                    }));

                    let pairAddresses = [];
                    try {
                        const res = await multicall.aggregate(callsPairAddr);
                        pairAddresses = res.returnData.map(d => ethers.utils.defaultAbiCoder.decode(['address'], d)[0]);
                    } catch (e) {
                        for (let i of indices) {
                            try {
                                pairAddresses.push(await callWithRetry(() => factory.allPairs(i), `allPairs-${dexName}-${i}`));
                            } catch {
                                pairAddresses.push(null);
                            }
                        }
                    }

                    const valid = pairAddresses.filter(a => a && a !== '0x0000000000000000000000000000000000000000');
                    if (!valid.length) continue;

                    const tkCalls = [];
                    for (let addr of valid) {
                        tkCalls.push({ target: addr, callData: pairIface.encodeFunctionData('token0', []) });
                        tkCalls.push({ target: addr, callData: pairIface.encodeFunctionData('token1', []) });
                    }

                    let t0List = [],
                        t1List = [];
                    try {
                        const tkRes = await multicall.aggregate(tkCalls);
                        for (let j = 0; j < valid.length; j++) {
                            t0List.push(ethers.utils.defaultAbiCoder.decode(['address'], tkRes.returnData[j * 2])[0].toLowerCase());
                            t1List.push(ethers.utils.defaultAbiCoder.decode(['address'], tkRes.returnData[j * 2 + 1])[0].toLowerCase());
                        }
                    } catch (e) {
                        for (let addr of valid) {
                            try {
                                const p = new ethers.Contract(addr, PAIR_ABI, provider);
                                const [t0, t1] = await Promise.all([
                                    callWithRetry(() => p.token0(), `token0-${addr}`),
                                    callWithRetry(() => p.token1(), `token1-${addr}`)
                                ]);
                                t0List.push(t0.toLowerCase());
                                t1List.push(t1.toLowerCase());
                            } catch {
                                t0List.push(null);
                                t1List.push(null);
                            }
                        }
                    }

                    const tempPairs = [];
                    for (let j = 0; j < valid.length; j++) {
                        if (t0List[j] && t1List[j]) {
                            tempPairs.push({
                                address: valid[j],
                                token0: t0List[j],
                                token1: t1List[j]
                            });

                            if (!tokenInfo.has(t0List[j])) {
                                getTokenInfo(t0List[j]).catch(() => {});
                            }
                            if (!tokenInfo.has(t1List[j])) {
                                getTokenInfo(t1List[j]).catch(() => {});
                            }
                        }
                    }

                    const resCalls = tempPairs.map(p => ({
                        target: p.address,
                        callData: pairIface.encodeFunctionData('getReserves', [])
                    }));

                    let reservesList = [];
                    try {
                        const resRes = await multicall.aggregate(resCalls);
                        for (let idx = 0; idx < tempPairs.length; idx++) {
                            const dec = pairIface.decodeFunctionResult('getReserves', resRes.returnData[idx]);
                            reservesList.push({ reserve0: dec.reserve0, reserve1: dec.reserve1 });
                        }
                    } catch (e) {
                        for (let p of tempPairs) {
                            try {
                                const pc = new ethers.Contract(p.address, PAIR_ABI, provider);
                                const r = await callWithRetry(() => pc.getReserves(), `reserves-${p.address}`);
                                reservesList.push({ reserve0: r.reserve0, reserve1: r.reserve1 });
                            } catch {
                                reservesList.push({ reserve0: ethers.BigNumber.from(0), reserve1: ethers.BigNumber.from(0) });
                            }
                        }
                    }

                    let added = 0,
                        filtered = 0,
                        updated = 0;
                    for (let i = 0; i < tempPairs.length; i++) {
                        const p = tempPairs[i];
                        const pairObj = {
                            dex: dexName,
                            address: p.address,
                            token0: p.token0,
                            token1: p.token1,
                            reserve0: reservesList[i].reserve0,
                            reserve1: reservesList[i].reserve1
                        };

                        const hasNative = (p.token0 === CONFIG.NATIVE || p.token1 === CONFIG.NATIVE);
                        if (hasNative && CONFIG.minLiquidity > 0 && !checkLiquidity(pairObj, CONFIG.minLiquidity)) {
                            filtered++;
                            continue;
                        }

                        const existingIndex = allPairs.findIndex(pair => pair.address === pairObj.address);
                        if (existingIndex >= 0) {
                            allPairs[existingIndex] = pairObj;
                            updated++;
                        } else {
                            allPairs.push(pairObj);
                            added++;
                        }

                        if (!pairsByToken.has(p.token0)) pairsByToken.set(p.token0, []);
                        const token0Pairs = pairsByToken.get(p.token0).filter(pair => pair.address !== pairObj.address);
                        token0Pairs.push(pairObj);
                        pairsByToken.set(p.token0, token0Pairs);

                        if (!pairsByToken.has(p.token1)) pairsByToken.set(p.token1, []);
                        const token1Pairs = pairsByToken.get(p.token1).filter(pair => pair.address !== pairObj.address);
                        token1Pairs.push(pairObj);
                        pairsByToken.set(p.token1, token1Pairs);

                        pairMap.set(`${dexName}_${p.token0}_${p.token1}`, pairObj);
                        pairMap.set(`${dexName}_${p.token1}_${p.token0}`, pairObj);
                    }

                    log(`   Batch ${start}-${end} ${dexName}: +${added} new, ${updated} updated, ${filtered} filtered`);
                }
            }

            async function loadAllPairsSequential() {
                if (isLoadingPairs) {
                    log('⏳ Loading pair sedang berlangsung...', 'DEBUG');
                    return;
                }

                isLoadingPairs = true;

                try {
                    allPairs = [];
                    pairsByToken.clear();
                    pairMap.clear();
                    tokenInfo.clear();
                    tokenInfo.set(CONFIG.NATIVE, { symbol: CONFIG.wrappedSymbol, decimals: 18 });
                    blacklistedTokens.clear();

                    if (!multicall) {
                        multicall = new ethers.Contract(CONFIG.multicallAddress, MULTICALL_ABI, provider);
                    }

                    log('🔄 Memulai loading pair...');

                    if (CONFIG.factories.dex1) {
                        await loadPairsFromFactory('dex1', CONFIG.factories.dex1);
                    }
                    if (CONFIG.factories.dex2) {
                        await loadPairsFromFactory('dex2', CONFIG.factories.dex2);
                    }
                    if (CONFIG.factories.dex3) {
                        await loadPairsFromFactory('dex3', CONFIG.factories.dex3);
                    }

                    log(`✅ Total pair dimuat: ${allPairs.length}`);
                } finally {
                    isLoadingPairs = false;
                }
            }

            async function refreshAllReserves() {
                if (!multicall || allPairs.length === 0) return;

                const pairIface = new ethers.utils.Interface(PAIR_ABI);
                const calls = allPairs.map(p => ({ target: p.address, callData: pairIface.encodeFunctionData('getReserves', []) }));

                try {
                    const res = await multicall.aggregate(calls);
                    let updated = 0;
                    for (let i = 0; i < allPairs.length; i++) {
                        try {
                            const dec = pairIface.decodeFunctionResult('getReserves', res.returnData[i]);
                            allPairs[i].reserve0 = dec.reserve0;
                            allPairs[i].reserve1 = dec.reserve1;
                            updated++;
                        } catch (e) {}
                    }
                    log(`🔄 Reserves diperbarui: ${updated}/${allPairs.length} pair`);
                } catch (e) {
                    log(`Refresh reserves gagal: ${e.message}`, 'WARN');
                }
            }

            async function checkConnection() {
                if (!provider || !botRunning) return false;
                try {
                    const blockNumber = await provider.getBlockNumber();
                    if (blockNumber > 0) {
                        lastBlockNumber = blockNumber;
                        reconnectAttempts = 0;
                        
                        return true;
                    }
                    return false;
                } catch (e) {
                    
                    return false;
                }
            }

            async function reconnectProvider() {
                log('🔄 Mencoba reconnect...', 'WARN');
                try {
                    if (provider && provider._websocket) {
                        provider._websocket.close();
                    }
                } catch (e) {}

                reconnectAttempts++;

                try {
                    provider = new ethers.providers.WebSocketProvider(CONFIG.rpcUrl);

                    provider._websocket.onclose = () => {
                        if (botRunning && !stopRequested) {
                            setTimeout(() => reconnectProvider(), 5000);
                        }
                    };

                    provider._websocket.onerror = (err) => {
                        log(`WebSocket error: ${err.message}`, 'ERROR');
                    };

                    await provider.getNetwork();

                    if (CONFIG.privateKey) {
                        signer = new ethers.Wallet(CONFIG.privateKey.startsWith('0x') ? CONFIG.privateKey : '0x' + CONFIG.privateKey, provider);
                        account = signer.address;
                    }

                    multicall = new ethers.Contract(CONFIG.multicallAddress, MULTICALL_ABI, provider);

                    await validateMulticall();
                    await loadAllPairsSequential();
                    await refreshAllReserves();

                    

                    log('✅ Reconnect berhasil.', 'INFO');
                    reconnectAttempts = 0;
                    return true;

                } catch (e) {
                    log(`❌ Reconnect gagal (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}): ${e.message}`, 'ERROR');
                    

                    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        const delay = Math.min(10000 * Math.pow(2, reconnectAttempts - 1), 10000);
                        setTimeout(() => reconnectProvider(), delay);
                    } else {
                        log('❌ Gagal reconnect, stop bot', 'ERROR');
                        botRunning = false; stopRequested = true;
                    }

                    return false;
                }
            }

            // ==================== DETEKSI OPPORTUNITY ====================

            function isTokenBlacklisted(tokenAddr) {
                try {
                    if (!blacklistedTokens.has(tokenAddr)) return false;
                    const expiry = blacklistedTokens.get(tokenAddr);
                    if (Date.now() > expiry) {
                        blacklistedTokens.delete(tokenAddr);
                        return false;
                    }
                    return true;
                } catch (e) {
                    return false;
                }
            }

            function validatePath(opportunity) {
                try {
                    const uniqueTokens = new Set(opportunity.tokens);
                    if (uniqueTokens.size !== opportunity.tokens.length) {
                        return false;
                    }
                    const path = opportunity.path;
                    if (path[0] !== CONFIG.NATIVE || path[path.length - 1] !== CONFIG.NATIVE) {
                        return false;
                    }
                    const uniqueDexes = new Set(opportunity.dexes);
                    if (uniqueDexes.size < 2) {
                        return false;
                    }
                    return true;
                } catch (e) {
                    return false;
                }
            }

            async function findMultiHopArbitrage() {
                try {
                    const opportunities = [];
                    const maxHops = CONFIG.maxHops || 3;

                    const nativePairs = allPairs.filter(p => p.token0 === CONFIG.NATIVE || p.token1 === CONFIG.NATIVE);
                    const nativeTokens = new Set();
                    for (let p of nativePairs) {
                        nativeTokens.add(p.token0 === CONFIG.NATIVE ? p.token1 : p.token0);
                    }

                    if (maxHops >= 2) {
                        for (let token of nativeTokens) {
                            if (isTokenBlacklisted(token)) continue;

                            const dexList = [];
                            for (let p of nativePairs) {
                                const other = p.token0 === CONFIG.NATIVE ? p.token1 : p.token0;
                                if (other === token) dexList.push(p.dex);
                            }

                            if (dexList.length >= 2) {
                                for (let i = 0; i < dexList.length; i++) {
                                    for (let j = i + 1; j < dexList.length; j++) {
                                        if (dexList[i] === dexList[j]) continue;

                                        const tokenInfoData = tokenInfo.get(token) || { symbol: token.slice(0, 6) };
                                        opportunities.push({
                                            type: "multi-hop",
                                            hopCount: 2,
                                            path: [CONFIG.NATIVE, token, CONFIG.NATIVE],
                                            dexes: [dexList[i], dexList[j]],
                                            tokens: [token],
                                            description: `2-hop: RIC-[${dexList[i]}]->${tokenInfoData.symbol}-[${dexList[j]}]->RIC`
                                        });
                                    }
                                }
                            }
                        }
                    }

                    if (maxHops >= 3) {
                        for (let tokenA of nativeTokens) {
                            if (isTokenBlacklisted(tokenA)) continue;

                            const pairsA = pairsByToken.get(tokenA) || [];

                            for (let pairAB of pairsA) {
                                const tokenB = pairAB.token0 === tokenA ? pairAB.token1 : pairAB.token0;
                                if (tokenB === CONFIG.NATIVE || isTokenBlacklisted(tokenB)) continue;

                                const pairsB = pairsByToken.get(tokenB)?.filter(p =>
                                    p.token0 === CONFIG.NATIVE || p.token1 === CONFIG.NATIVE
                                ) || [];

                                if (pairsB.length === 0) continue;

                                const buyDexes = nativePairs.filter(p => {
                                    const other = p.token0 === CONFIG.NATIVE ? p.token1 : p.token0;
                                    return other === tokenA;
                                }).map(p => p.dex);

                                for (let buyDex of buyDexes) {
                                    const midDex = pairAB.dex;

                                    for (let sellPair of pairsB) {
                                        const sellDex = sellPair.dex;

                                        if (buyDex === midDex && midDex === sellDex) continue;

                                        const tokenAInfo = tokenInfo.get(tokenA) || { symbol: tokenA.slice(0, 6) };
                                        const tokenBInfo = tokenInfo.get(tokenB) || { symbol: tokenB.slice(0, 6) };

                                        opportunities.push({
                                            type: "multi-hop",
                                            hopCount: 3,
                                            path: [CONFIG.NATIVE, tokenA, tokenB, CONFIG.NATIVE],
                                            dexes: [buyDex, midDex, sellDex],
                                            tokens: [tokenA, tokenB],
                                            description: `3-hop: RIC-[${buyDex}]->${tokenAInfo.symbol}-[${midDex}]->${tokenBInfo.symbol}-[${sellDex}]->RIC`
                                        });
                                    }
                                }
                            }
                        }
                    }

                    return opportunities;
                } catch (e) {
                    log(`Error di findMultiHopArbitrage: ${e.message}`, "ERROR");
                    return [];
                }
            }

            async function findComplexTriangularArbitrage() {
                try {
                    const opportunities = [];

                    const allTokens = new Set();
                    allPairs.forEach(p => {
                        if (p.token0 !== CONFIG.NATIVE) allTokens.add(p.token0);
                        if (p.token1 !== CONFIG.NATIVE) allTokens.add(p.token1);
                    });

                    const tokenList = Array.from(allTokens);

                    for (let i = 0; i < tokenList.length; i++) {
                        const tokenA = tokenList[i];
                        if (isTokenBlacklisted(tokenA)) continue;

                        for (let j = 0; j < tokenList.length; j++) {
                            if (i === j) continue;

                            const tokenB = tokenList[j];
                            if (isTokenBlacklisted(tokenB)) continue;

                            const pairsA_WRIC = allPairs.filter(p =>
                                (p.token0 === tokenA && p.token1 === CONFIG.NATIVE) ||
                                (p.token0 === CONFIG.NATIVE && p.token1 === tokenA)
                            );

                            const pairsB_WRIC = allPairs.filter(p =>
                                (p.token0 === tokenB && p.token1 === CONFIG.NATIVE) ||
                                (p.token0 === CONFIG.NATIVE && p.token1 === tokenB)
                            );

                            const pairsAB = allPairs.filter(p =>
                                (p.token0 === tokenA && p.token1 === tokenB) ||
                                (p.token0 === tokenB && p.token1 === tokenA)
                            );

                            if (pairsA_WRIC.length === 0 || pairsB_WRIC.length === 0 || pairsAB.length === 0) continue;

                            for (let pairAB of pairsAB) {
                                const dexAB = pairAB.dex;

                                for (let pairA_WRIC of pairsA_WRIC) {
                                    const dexA = pairA_WRIC.dex;

                                    for (let pairB_WRIC of pairsB_WRIC) {
                                        const dexB = pairB_WRIC.dex;

                                        if (dexA === dexAB && dexAB === dexB) continue;

                                        const priceComparison = calculateImpliedPrices(pairAB, pairA_WRIC, pairB_WRIC, tokenA, tokenB);

                                        // TIDAK ADA BATASAN MIN PROFIT - ambil semua
                                        if (priceComparison && priceComparison.percentDiff !== 0) {
                                            const tokenAInfo = tokenInfo.get(tokenA) || { symbol: tokenA.slice(0, 6) };
                                            const tokenBInfo = tokenInfo.get(tokenB) || { symbol: tokenB.slice(0, 6) };

                                            let path, dexes, tokens, description;

                                            if (priceComparison.percentDiff > 0) {
                                                path = [CONFIG.NATIVE, tokenB, tokenA, CONFIG.NATIVE];
                                                dexes = [dexB, dexAB, dexA];
                                                tokens = [tokenB, tokenA];
                                                description = `Complex: RIC-[${dexB}]->${tokenBInfo.symbol}-[${dexAB}]->${tokenAInfo.symbol}-[${dexA}]->RIC (${priceComparison.percentDiff.toFixed(4)}% gain)`;
                                            } else {
                                                path = [CONFIG.NATIVE, tokenA, tokenB, CONFIG.NATIVE];
                                                dexes = [dexA, dexAB, dexB];
                                                tokens = [tokenA, tokenB];
                                                description = `Complex: RIC-[${dexA}]->${tokenAInfo.symbol}-[${dexAB}]->${tokenBInfo.symbol}-[${dexB}]->RIC (${Math.abs(priceComparison.percentDiff).toFixed(4)}% gain)`;
                                            }

                                            const opportunity = {
                                                type: "complex-triangular",
                                                hopCount: 2,
                                                path: path,
                                                dexes: dexes,
                                                tokens: tokens,
                                                description: description,
                                                priceDiff: priceComparison.percentDiff
                                            };

                                            if (validatePath(opportunity)) {
                                                opportunities.push(opportunity);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    return opportunities;
                } catch (e) {
                    log(`Error di findComplexTriangularArbitrage: ${e.message}`, "ERROR");
                    return [];
                }
            }

            function calculateImpliedPrices(pairAB, pairA_WRIC, pairB_WRIC, tokenA, tokenB) {
                try {
                    const WRIC = CONFIG.NATIVE;
                    const SCALE = ethers.BigNumber.from(10).pow(18);

                    // Semua harga internal dinormalisasi ke 18 desimal.
                    // Reserve token TIDAK boleh diasumsikan 18 desimal.
                    function normalizedReserve(pair, token, reserve) {
                        const info = tokenInfo.get(token) || { decimals: 18 };
                        return normalizeToEther(reserve, Number(info.decimals));
                    }

                    function getTokenPriceInWRIC(pair, token) {
                        if (pair.token0 === WRIC && pair.token1 === token) {
                            const reserveWRIC = normalizeToEther(pair.reserve0, 18);
                            const reserveToken = normalizedReserve(pair, token, pair.reserve1);
                            if (reserveToken.isZero()) return ethers.BigNumber.from(0);
                            return reserveWRIC.mul(SCALE).div(reserveToken);
                        }

                        if (pair.token0 === token && pair.token1 === WRIC) {
                            const reserveToken = normalizedReserve(pair, token, pair.reserve0);
                            const reserveWRIC = normalizeToEther(pair.reserve1, 18);
                            if (reserveToken.isZero()) return ethers.BigNumber.from(0);
                            return reserveWRIC.mul(SCALE).div(reserveToken);
                        }

                        return ethers.BigNumber.from(0);
                    }

                    const priceA_direct = getTokenPriceInWRIC(pairA_WRIC, tokenA);
                    if (priceA_direct.isZero()) return null;

                    const priceB = getTokenPriceInWRIC(pairB_WRIC, tokenB);
                    if (priceB.isZero()) return null;

                    let ratioAB;

                    if (pairAB.token0 === tokenA && pairAB.token1 === tokenB) {
                        const reserveA = normalizedReserve(pairAB, tokenA, pairAB.reserve0);
                        const reserveB = normalizedReserve(pairAB, tokenB, pairAB.reserve1);
                        if (reserveA.isZero()) return null;
                        ratioAB = reserveB.mul(SCALE).div(reserveA);
                    } else if (pairAB.token0 === tokenB && pairAB.token1 === tokenA) {
                        const reserveB = normalizedReserve(pairAB, tokenB, pairAB.reserve0);
                        const reserveA = normalizedReserve(pairAB, tokenA, pairAB.reserve1);
                        if (reserveB.isZero()) return null;
                        ratioAB = reserveA.mul(SCALE).div(reserveB);
                    } else {
                        return null;
                    }

                    if (ratioAB.isZero()) return null;

                    const priceA_viaB = priceB.mul(ratioAB).div(SCALE);
                    if (priceA_viaB.isZero()) return null;

                    // Hindari BigNumber underflow ketika harga via-B lebih kecil.
                    const percentDiff = priceA_viaB.gte(priceA_direct)
                        ? priceA_viaB.sub(priceA_direct).mul(10000).div(priceA_direct).toNumber() / 100
                        : -priceA_direct.sub(priceA_viaB).mul(10000).div(priceA_direct).toNumber() / 100;

                    const diff = priceA_viaB.gte(priceA_direct)
                        ? priceA_viaB.sub(priceA_direct)
                        : ethers.BigNumber.from(0).sub(priceA_direct.sub(priceA_viaB));

                    return {
                        direct: priceA_direct,
                        viaB: priceA_viaB,
                        diff,
                        percentDiff
                    };
                } catch (e) {
                    return null;
                }
            }

            async function findAllOpportunities() {
                try {
                    const multiHop = await findMultiHopArbitrage();
                    const complex = await findComplexTriangularArbitrage();
                    return [...multiHop, ...complex];
                } catch (e) {
                    log(`Error di findAllOpportunities: ${e.message}`, "ERROR");
                    return [];
                }
            }

            // ==================== SIMULASI & EKSEKUSI ====================

            async function simulateMultiHop(opportunity, amountNative) {
                try {
                    if (opportunity.hopCount === 2) {
                        const [tokenA] = opportunity.tokens;
                        const [dex1, dex2] = opportunity.dexes;

                        const amountA = getAmountOut(amountNative, CONFIG.NATIVE, tokenA, dex1);
                        if (amountA.isZero()) return ethers.BigNumber.from(0);

                        return getAmountOut(amountA, tokenA, CONFIG.NATIVE, dex2);

                    } else if (opportunity.hopCount === 3) {
                        const [tokenA, tokenB] = opportunity.tokens;
                        const [dex1, dex2, dex3] = opportunity.dexes;

                        const amountA = getAmountOut(amountNative, CONFIG.NATIVE, tokenA, dex1);
                        if (amountA.isZero()) return ethers.BigNumber.from(0);

                        const amountB = getAmountOut(amountA, tokenA, tokenB, dex2);
                        if (amountB.isZero()) return ethers.BigNumber.from(0);

                        return getAmountOut(amountB, tokenB, CONFIG.NATIVE, dex3);
                    }

                    return ethers.BigNumber.from(0);
                } catch (e) {
                    return ethers.BigNumber.from(0);
                }
            }

            async function simulateComplexTriangular(opportunity, amountNative) {
                try {
                    const tokens = opportunity.tokens;
                    const dexes = opportunity.dexes;

                    const amountToken1 = getAmountOut(amountNative, CONFIG.NATIVE, tokens[0], dexes[0]);
                    if (amountToken1.isZero()) return ethers.BigNumber.from(0);

                    const amountToken2 = getAmountOut(amountToken1, tokens[0], tokens[1], dexes[1]);
                    if (amountToken2.isZero()) return ethers.BigNumber.from(0);

                    return getAmountOut(amountToken2, tokens[1], CONFIG.NATIVE, dexes[2]);

                } catch (e) {
                    return ethers.BigNumber.from(0);
                }
            }

            async function simulateOpportunity(opp, amountNative) {
                try {
                    if (opp.type === "multi-hop") {
                        return await simulateMultiHop(opp, amountNative);
                    } else if (opp.type === "complex-triangular") {
                        return await simulateComplexTriangular(opp, amountNative);
                    }
                    return ethers.BigNumber.from(0);
                } catch (e) {
                    return ethers.BigNumber.from(0);
                }
            }

            // ==================== FIND BEST AMOUNT - ADAPTIVE + NET PROFIT ====================
            function getEstimatedGasUnits(opp) {
                // complex-triangular memakai 3 swap walaupun hopCount historisnya 2.
                if (opp.type === 'complex-triangular') return CONFIG.gasEstimate3Hop;
                if (opp.hopCount === 2) return CONFIG.gasEstimate2Hop;
                if (opp.hopCount === 3) return CONFIG.gasEstimate3Hop;
                return CONFIG.gasEstimate4Hop;
            }

            function addCandidate(candidates, amount, maxNative) {
                if (!amount || amount.isZero()) return;
                if (amount.gt(maxNative)) return;
                const minTrade = parseEther(CONFIG.minTradeNative);
                if (amount.lt(minTrade)) return;
                candidates.set(amount.toString(), amount);
            }

            function buildAmountCandidates(maxNative) {
                const candidates = new Map();
                const minTrade = parseEther(CONFIG.minTradeNative);

                if (maxNative.lt(minTrade)) return [];

                // Grid absolut/logaritmik. Ukuran trade tetap tersedia walaupun
                // wallet membesar dari 0.x menjadi puluhan/ratusan WRIC.
                const base = [
                    '0.00001', '0.00002', '0.00005',
                    '0.0001', '0.0002', '0.0005',
                    '0.001', '0.002', '0.005',
                    '0.01', '0.02', '0.05',
                    '0.1', '0.2', '0.5',
                    '1', '2', '5', '10', '20', '50', '100'
                ];

                for (const value of base) {
                    try { addCandidate(candidates, parseEther(value), maxNative); } catch (_) {}
                }

                // Selalu uji maksimum wallet juga, tetapi jangan mengandalkannya.
                addCandidate(candidates, maxNative, maxNative);

                return Array.from(candidates.values())
                    .sort((a, b) => a.lt(b) ? -1 : a.gt(b) ? 1 : 0)
                    .slice(0, CONFIG.amountSearchMaxCandidates);
            }

            async function findBestAmount(opp, maxNative) {
                try {
                    const effectiveGasPrice = await getEffectiveGasPrice();
                    const estimatedGasCost = effectiveGasPrice.mul(getEstimatedGasUnits(opp));

                    const candidateAmounts = buildAmountCandidates(maxNative);
                    const candidates = new Map(candidateAmounts.map(amount => [amount.toString(), amount]));
                    if (candidates.length === 0) {
                        return {
                            amount: ethers.BigNumber.from(0),
                            profit: ethers.BigNumber.from(0),
                            grossProfit: ethers.BigNumber.from(0),
                            gasCost: estimatedGasCost
                        };
                    }

                    const results = [];

                    // Simulasi awal. Unprofitable candidate TIDAK boleh menghentikan
                    // seluruh pencarian (bug utama pada versi lama).
                    for (const amount of candidates.values()) {
                        try {
                            const result = await simulateOpportunity(opp, amount);
                            if (!result || result.isZero()) continue;

                            // BigNumber.sub() tidak boleh dipanggil jika result < amount.
                            // Ini penting: loss pada satu ukuran adalah data, bukan exception.
                            if (result.lte(amount)) continue;

                            const grossProfit = result.sub(amount);
                            const netProfit = grossProfit.sub(estimatedGasCost);

                            if (netProfit.gt(0)) {
                                results.push({ amount, grossProfit, netProfit });
                            }
                        } catch (e) {
                            log(`Simulasi ukuran ${formatEther(amount)} gagal: ${e.message}`, 'DEBUG');
                        }
                    }

                    // Refinement lokal di sekitar kandidat terbaik.
                    if (results.length > 0 && CONFIG.amountSearchRefineSteps > 0) {
                        results.sort((a, b) => b.netProfit.gt(a.netProfit) ? 1 : b.netProfit.lt(a.netProfit) ? -1 : 0);

                        const best = results[0];
                        const sortedCandidates = Array.from(candidates.values());

                        let lower = ethers.BigNumber.from(0);
                        let upper = maxNative;

                        for (let i = 0; i < sortedCandidates.length; i++) {
                            if (sortedCandidates[i].eq(best.amount)) {
                                lower = i > 0 ? sortedCandidates[i - 1] : ethers.BigNumber.from(0);
                                upper = i + 1 < sortedCandidates.length ? sortedCandidates[i + 1] : maxNative;
                                break;
                            }
                        }

                        if (upper.lt(best.amount)) upper = maxNative;

                        // Tambahkan titik di antara lower -> upper untuk menangkap
                        // optimum yang berada di antara grid kasar.
                        for (let i = 1; i <= CONFIG.amountSearchRefineSteps; i++) {
                            const span = upper.sub(lower);
                            if (span.isZero()) break;

                            const refined = lower.add(
                                span.mul(i).div(CONFIG.amountSearchRefineSteps + 1)
                            );

                            addCandidate(candidates, refined, maxNative);
                        }

                        const refinedCandidates = Array.from(candidates.values());
                        for (const amount of refinedCandidates) {
                            if (results.some(r => r.amount.eq(amount))) continue;

                            try {
                                const result = await simulateOpportunity(opp, amount);
                                if (!result || result.isZero() || result.lte(amount)) continue;

                                const grossProfit = result.sub(amount);
                                const netProfit = grossProfit.sub(estimatedGasCost);

                                if (netProfit.gt(0)) {
                                    results.push({ amount, grossProfit, netProfit });
                                }
                            } catch (_) {}
                        }
                    }

                    if (results.length === 0) {
                        return {
                            amount: ethers.BigNumber.from(0),
                            profit: ethers.BigNumber.from(0),
                            grossProfit: ethers.BigNumber.from(0),
                            gasCost: estimatedGasCost
                        };
                    }

                    results.sort((a, b) => {
                        if (a.netProfit.eq(b.netProfit)) return 0;
                        return a.netProfit.gt(b.netProfit) ? -1 : 1;
                    });

                    const best = results[0];

                    log(
                        `🔍 Best amount: ${formatEther(best.amount)} WRIC | ` +
                        `gross=${formatEther(best.grossProfit)} | ` +
                        `gas≈${formatEther(estimatedGasCost)} | ` +
                        `NET=${formatEther(best.netProfit)} WRIC`,
                        'DEBUG'
                    );

                    return {
                        amount: best.amount,
                        // Tetap "profit" sebagai gross untuk kompatibilitas caller lama.
                        profit: best.grossProfit,
                        grossProfit: best.grossProfit,
                        netProfit: best.netProfit,
                        gasCost: estimatedGasCost
                    };
                } catch (e) {
                    log(`Error di findBestAmount: ${e.message}`, 'WARN');
                    return {
                        amount: ethers.BigNumber.from(0),
                        profit: ethers.BigNumber.from(0),
                        grossProfit: ethers.BigNumber.from(0),
                        netProfit: ethers.BigNumber.from(0),
                        gasCost: ethers.BigNumber.from(0)
                    };
                }
            }

            async function ensureAllowance(tokenAddr, routerAddr) {
                try {
                    const token = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
                    const allowance = await callWithRetry(() => token.allowance(account, routerAddr), `allowance ${tokenAddr}`);
                    if (allowance.lt(ethers.constants.MaxUint256.div(2))) {
                        const tokenInfoData = tokenInfo.get(tokenAddr) || { symbol: tokenAddr.slice(0, 6) };
                        log(`🔓 Approve ${tokenInfoData.symbol}...`);
                        const gasPriceObj = await getCurrentGasPrice();
                        const tx = await token.approve(routerAddr, ethers.constants.MaxUint256, { ...gasPriceObj, gasLimit: 100000 });
                        await tx.wait();
                        log(`✅ Approve selesai`);
                    }
                } catch (e) {
                    log(`Gagal approve: ${e.message}`, "WARN");
                }
            }

            // ==================== SWAP DENGAN SLIPPAGE 0 ====================
            async function swapOnDex(dex, amountIn, tokenIn, tokenOut, hopIndex, totalHops) {
                try {
                    const routerAddr = CONFIG.routers[dex];
                    if (!routerAddr) throw new Error(`DEX ${dex} tidak dikenal`);

                    // Slippage eksekusi kecil agar quote tidak terlalu mudah
                    // revert ketika reserve berubah beberapa detik sebelum mining.
                    const slippageBps = CONFIG.executionSlippageBps;

                    await ensureAllowance(tokenIn, routerAddr);
                    const router = new ethers.Contract(routerAddr, ROUTER_ABI, signer);
                    const path = [tokenIn, tokenOut];
                    const deadline = Math.floor(Date.now() / 1000) + 600;

                    const amounts = await router.getAmountsOut(amountIn, path);
                    const amountOut = amounts[1];
                    const amountOutMin = amountOut
                        .mul(10000 - slippageBps)
                        .div(10000);

                    const gasPriceObj = await getCurrentGasPrice();

                    let useSupportingFee = false;
                    try {
                        await router.callStatic.swapExactTokensForTokens(amountIn, amountOutMin, path, account, deadline);
                    } catch (e) {
                        useSupportingFee = true;
                    }

                    let tx;
                    if (useSupportingFee) {
                        tx = await router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
                            amountIn, amountOutMin, path, account, deadline, { ...gasPriceObj }
                        );
                    } else {
                        tx = await router.swapExactTokensForTokens(
                            amountIn, amountOutMin, path, account, deadline, { ...gasPriceObj }
                        );
                    }

                    const receipt = await tx.wait();
                    log(`   ✅ Swap ${dex} selesai (gas: ${receipt.gasUsed})`);

                    return {
                        amountOut,
                        gasUsed: receipt.gasUsed,
                        slippageUsed: slippageBps
                    };
                } catch (e) {
                    log(`   ❌ Swap gagal di ${dex}: ${e.message}`, 'ERROR');
                    throw e;
                }
            }

            async function executeMultiHop(opportunity, amountNative) {
                try {
                    log(`🔄 Executing: ${opportunity.description}`);

                    let totalGas = ethers.BigNumber.from(0);
                    let nativeBalance = amountNative;
                    const pathAmounts = [amountNative];

                    if (opportunity.hopCount === 2) {
                        const [tokenA] = opportunity.tokens;
                        const [dex1, dex2] = opportunity.dexes;

                        const result1 = await swapOnDex(dex1, nativeBalance, CONFIG.NATIVE, tokenA, 1, 2);
                        totalGas = totalGas.add(result1.gasUsed);
                        pathAmounts.push(result1.amountOut);

                        const result2 = await swapOnDex(dex2, result1.amountOut, tokenA, CONFIG.NATIVE, 2, 2);
                        totalGas = totalGas.add(result2.gasUsed);
                        pathAmounts.push(result2.amountOut);

                        nativeBalance = result2.amountOut;

                    } else if (opportunity.hopCount === 3) {
                        const [tokenA, tokenB] = opportunity.tokens;
                        const [dex1, dex2, dex3] = opportunity.dexes;

                        const result1 = await swapOnDex(dex1, nativeBalance, CONFIG.NATIVE, tokenA, 1, 3);
                        totalGas = totalGas.add(result1.gasUsed);
                        pathAmounts.push(result1.amountOut);

                        const result2 = await swapOnDex(dex2, result1.amountOut, tokenA, tokenB, 2, 3);
                        totalGas = totalGas.add(result2.gasUsed);
                        pathAmounts.push(result2.amountOut);

                        const result3 = await swapOnDex(dex3, result2.amountOut, tokenB, CONFIG.NATIVE, 3, 3);
                        totalGas = totalGas.add(result3.gasUsed);
                        pathAmounts.push(result3.amountOut);

                        nativeBalance = result3.amountOut;
                    }

                    return {
                        nativeBalance,
                        totalGas,
                        pathAmounts
                    };
                } catch (e) {
                    throw e;
                }
            }

            async function executeComplexTriangular(opportunity, amountNative) {
                try {
                    log(`🔄 Executing Complex Triangular: ${opportunity.description}`);

                    const tokens = opportunity.tokens;
                    const dexes = opportunity.dexes;

                    let totalGas = ethers.BigNumber.from(0);
                    let nativeBalance = amountNative;
                    const pathAmounts = [amountNative];

                    const result1 = await swapOnDex(dexes[0], nativeBalance, CONFIG.NATIVE, tokens[0], 1, 3);
                    totalGas = totalGas.add(result1.gasUsed);
                    pathAmounts.push(result1.amountOut);

                    const result2 = await swapOnDex(dexes[1], result1.amountOut, tokens[0], tokens[1], 2, 3);
                    totalGas = totalGas.add(result2.gasUsed);
                    pathAmounts.push(result2.amountOut);

                    const result3 = await swapOnDex(dexes[2], result2.amountOut, tokens[1], CONFIG.NATIVE, 3, 3);
                    totalGas = totalGas.add(result3.gasUsed);
                    pathAmounts.push(result3.amountOut);

                    nativeBalance = result3.amountOut;

                    return {
                        nativeBalance,
                        totalGas,
                        pathAmounts
                    };
                } catch (e) {
                    throw e;
                }
            }

            async function executeOpportunity(opp, amountWRIC, expectedProfit) {
                try {
                    if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
                        log(`⚠️ Cooldown aktif, skip`, 'WARN');
                        return false;
                    }

                    const initialWRIC = await getWRICBalance();
                    log(`\n💰 Modal: ${formatEther(amountWRIC)} WRIC`);

                    let totalGasUsed = ethers.BigNumber.from(0);

                    await refreshAllReserves();

                    const finalCheck = await simulateOpportunity(opp, amountWRIC);
                    if (finalCheck.isZero()) {
                        log(`❌ Verifikasi gagal: simulasi 0`, "WARN");
                        return false;
                    }

                    const profitCheck = finalCheck.sub(amountWRIC);

                    // TIDAK ADA FILTER - langsung eksekusi
                    if (profitCheck.lte(0)) {
                        log(`⚠️ Profit <= 0: ${formatEther(profitCheck)}`, "WARN");
                        return false;
                    }

                    const effectiveGasPrice = await getEffectiveGasPrice();
                    const estimatedGasAmount = getEstimatedGasUnits(opp);
                    const estimatedGasCost = effectiveGasPrice.mul(estimatedGasAmount);

                    // Gas harus lebih kecil dari profit
                    if (profitCheck.lt(estimatedGasCost)) {
                        log(`❌ Profit ${formatEther(profitCheck)} < gas ${formatEther(estimatedGasCost)}`, "WARN");
                        return false;
                    }

                    let result;
                    if (opp.type === "multi-hop") {
                        result = await executeMultiHop(opp, amountWRIC);
                    } else if (opp.type === "complex-triangular") {
                        result = await executeComplexTriangular(opp, amountWRIC);
                    } else {
                        log(`❌ Tipe tidak dikenal`, "ERROR");
                        return false;
                    }

                    totalGasUsed = totalGasUsed.add(result.totalGas);

                    const finalWRIC = await getWRICBalance();
                    const profitWRIC = finalWRIC.sub(initialWRIC);

                    const gasCostEth = effectiveGasPrice.mul(totalGasUsed);
                    const netProfit = profitWRIC.sub(gasCostEth);

                    const profitStr = formatEther(profitWRIC);
                    const netProfitStr = formatEther(netProfit);
                    const profitNum = parseFloat(profitStr);
                    const netProfitNum = parseFloat(netProfitStr);

                    const timeStr = new Date().toLocaleTimeString();

                    const profitPercent = ((profitNum / parseFloat(formatEther(amountWRIC))) * 100).toFixed(4) + '%';
                    const netProfitPercent = ((netProfitNum / parseFloat(formatEther(amountWRIC))) * 100).toFixed(4) + '%';

                    const historyData = {
                        time: timeStr,
                        profitEth: profitWRIC,
                        profitNum: profitNum,
                        gasUsed: totalGasUsed.toString(),
                        gasCostEth: gasCostEth,
                        netProfit: `${netProfitNum >= 0 ? '+' : ''}${netProfitNum.toFixed(6)} WRIC (${netProfitPercent})`,
                        status: netProfitNum >= 0 ? 'SUKSES' : 'RUGI',
                        hopCount: opp.hopCount,
                        path: opp.path || [CONFIG.NATIVE],
                        dexes: opp.dexes || [],
                        amounts: result.pathAmounts || [amountWRIC, result.nativeBalance],
                        modalEth: amountWRIC,
                        slippage: '0',
                        taxDetected: false,
                        profitPercent: profitPercent,
                        compounded: false
                    };

                    if (netProfit.lt(0)) {
                        log(`⚠️ RUGI setelah gas! Gross: ${profitStr} WRIC, Net: ${netProfitStr} WRIC`, "WARN");
                        historyData.status = 'RUGI';
                        historyData.profitNum = -Math.abs(profitNum);
                        addHistoryRecord(historyData);
                        showPopup(`RUGI NET: ${netProfitStr} WRIC`, 'loss');
                        if (opp.tokens?.[0]) blacklistedTokens.set(opp.tokens[0], Date.now() + 5 * 60 * 1000);
                        return false;
                    } else if (profitWRIC.lt(0)) {
                        log(`❌ RUGI! ${profitStr} WRIC`, "ERROR");
                        historyData.status = 'RUGI';
                        historyData.profitNum = -Math.abs(profitNum);
                        addHistoryRecord(historyData);
                        showPopup(`RUGI: ${profitStr} WRIC`, 'loss');
                        if (opp.tokens?.[0]) blacklistedTokens.set(opp.tokens[0], Date.now() + 5 * 60 * 1000);
                        return false;
                    } else {
                        log(`✅ PROFIT! +${profitStr} WRIC (Net: ${netProfitStr} WRIC) 🎉`);
                        historyData.status = 'SUKSES';
                        historyData.profitNum = Math.abs(profitNum);
                        addHistoryRecord(historyData);
                        showPopup(`PROFIT: +${netProfitStr} WRIC`, 'profit');
                        return true;
                    }

                } catch (e) {
                    log(`❌ Gagal eksekusi: ${e.message}`, "ERROR");
                    showPopup(`GAGAL: ${e.message.substring(0, 50)}...`, 'loss');
                    if (opp.tokens?.[0]) blacklistedTokens.set(opp.tokens[0], Date.now() + 5 * 60 * 1000);
                    return false;
                }
            }

            async function initProvider() {
                try {
                    provider = new ethers.providers.WebSocketProvider(CONFIG.rpcUrl);

                    provider._websocket.onclose = () => {
                        if (botRunning && !stopRequested) {
                            setTimeout(() => reconnectProvider(), 5000);
                        }
                    };

                    provider._websocket.onerror = (err) => {
                        log(`WebSocket error: ${err.message}`, 'ERROR');
                    };

                    await provider.getNetwork();

                    if (CONFIG.privateKey) {
                        signer = new ethers.Wallet(CONFIG.privateKey.startsWith('0x') ? CONFIG.privateKey : '0x' + CONFIG.privateKey, provider);
                        account = signer.address;
                    }

                    multicall = new ethers.Contract(CONFIG.multicallAddress, MULTICALL_ABI, provider);

                    await validateMulticall();

                    const balance = await provider.getBalance(account);
                    log(`👤 Wallet: ${account}`);
                    log(`💰 RIC Balance: ${formatEther(balance)} RIC`);

                    return true;
                } catch (e) {
                    log(`❌ Gagal init provider: ${e.message}`, "ERROR");
                    return false;
                }
            }

            
            // ==================== MAIN LOOP BRUTAL ====================
            async function mainLoop() {
                log("🔥 CRON RUN STARTED");
                log(`⚡ Gas ${CONFIG.gasPriceGwei} gwei | execution slippage ${CONFIG.executionSlippageBps} bps`);
                log("🎯 Cari ukuran trade optimal dari modal kecil sampai maksimum wallet; ranking berdasarkan NET setelah gas.");

                try {
                    if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
                        log(`⚠️ Cooldown aktif, skip run`, 'WARN');
                        return;
                    }

                    const connected = await checkConnection();
                    if (!connected) {
                        log(`❌ RPC tidak terhubung`, 'ERROR');
                        return;
                    }

                    const ricBalance = await provider.getBalance(account);
                    const wricBalance = await getWRICBalance();

                    log(`💰 Balance: ${formatEther(ricBalance)} RIC / ${formatEther(wricBalance)} WRIC`);

                    await refreshAllReserves();

                    const opportunities = await findAllOpportunities();
                    log(`🔎 Opportunity ditemukan: ${opportunities.length}`);

                    if (opportunities.length === 0) {
                        log("⏳ Tidak ada peluang", 'INFO');
                        return;
                    }

                    const maxUsable = wricBalance;

                    if (maxUsable.lte(0)) {
                        log("⚠️ WRIC tidak cukup", "WARN");
                        return;
                    }

                    const evaluated = [];
                    for (let opp of opportunities) {
                        try {
                            if (!validatePath(opp)) continue;

                            const evaluation = await findBestAmount(opp, maxUsable);

                            if (
                                evaluation.amount.gt(0) &&
                                evaluation.grossProfit.gt(0) &&
                                evaluation.netProfit.gt(0)
                            ) {
                                evaluated.push({
                                    opp,
                                    amount: evaluation.amount,
                                    profit: evaluation.grossProfit,
                                    netProfit: evaluation.netProfit,
                                    gasCost: evaluation.gasCost
                                });
                            }
                        } catch (e) {
                            log(`Error evaluasi: ${e.message}`, 'DEBUG');
                        }
                    }

                    // Prioritaskan NET profit setelah gas, bukan gross profit.
                    evaluated.sort((a, b) => {
                        if (a.netProfit.eq(b.netProfit)) return 0;
                        return a.netProfit.gt(b.netProfit) ? -1 : 1;
                    });

                    let executed = false;
                    for (let { opp, amount, profit, netProfit, gasCost } of evaluated.slice(0, 3)) {
                        log(`🎯 Mencoba: ${opp.description}`);
                        log(`   💰 Modal: ${formatEther(amount)} WRIC`);
                        log(`   📈 Gross: ${formatEther(profit)} WRIC`);
                        log(`   ⛽ Gas≈ ${formatEther(gasCost)} WRIC`);
                        log(`   💎 NET: ${formatEther(netProfit)} WRIC`);

                        const success = await executeOpportunity(opp, amount, profit);
                        if (success) {
                            executed = true;
                            break;
                        }
                    }

                    if (!executed) log("⏭️ Tidak ada peluang layak");
                } catch (e) {
                    log(`❌ Error di cron run: ${e.message}`, "ERROR");
                }
            }

            // ==================== CRON ENTRYPOINT ====================
            async function runCron() {
                stopRequested = false;
                botRunning = false;

                try {
                    CONFIG.routers = {
                        dex1: '0x8e9556415124b6c726d5c3610d25c24be8ac2304',
                        dex2: '0xad44b9d1ee10a0d12911df2295908c30d2904ab8',
                        dex3: '0x2125ea3c076298f13ca95e807607ae7a1369e1a8'
                    };

                    CONFIG.factories = {
                        dex1: '0xaeedf8b9925c6316171f7c2815e387de596fa11b',
                        dex2: '0x67d377767ede94f12ed6203cb0fcd02c824d3536',
                        dex3: '0x6ed514bc91cbd202c21bbc494d05c49fce4babef'
                    };

                    CONFIG.gasPriceGwei = 0.1;
                    CONFIG.maxHops = 3;
                    CONFIG.minLiquidity = 0.001;
                    CONFIG.loopDelay = 100;

                    CONFIG.privateKey = (process.env.BOT_PRIVATE_KEY || '').trim();

                    if (!CONFIG.privateKey) {
                        throw new Error('BOT_PRIVATE_KEY belum di-set');
                    }

                    if (!CONFIG.privateKey.startsWith('0x')) {
                        CONFIG.privateKey = '0x' + CONFIG.privateKey;
                    }

                    totalModal = ethers.BigNumber.from(0);
                    totalGas = ethers.BigNumber.from(0);
                    totalProfit = ethers.BigNumber.from(0);
                    totalLoss = ethers.BigNumber.from(0);
                    totalCompounded = ethers.BigNumber.from(0);
                    consecutiveLosses = 0;

                    log("=".repeat(60));
                    log("🔥 MODE BRUTAL CRON AKTIF");
                    log(`   • SLIPPAGE: 0% (ZERO)`);
                    log(`   • GAS PRICE: ${CONFIG.gasPriceGwei} GWEI (FIXED)`);
                    log(`   • MIN PROFIT: 0 (ambil semua)`);
                    log(`   • GAS BUFFER: 0 (tanpa toleransi)`);
                    log(`   • MAX HOPS: ${CONFIG.maxHops}`);
                    log(`   • MIN LIQUIDITY: ${CONFIG.minLiquidity} RIC`);
                    log(`   • LOOP DELAY: ${CONFIG.loopDelay}ms`);
                    log(`   • WRAP/UNWRAP: DISABLED — wallet sudah menyediakan RIC + WRIC`);
                    log("=".repeat(60));

                    const ok = await initProvider();
                    if (!ok) throw new Error('Gagal init provider');

                    botRunning = true;

                    await loadAllPairsSequential();
                    await refreshAllReserves();

                    await mainLoop();

                    log("🛑 Cron run selesai");
                } catch (e) {
                    log(`❌ Fatal cron: ${e.message}`, "ERROR");
                    process.exitCode = 1;
                } finally {
                    botRunning = false;
                    stopRequested = true;

                    if (connectionCheckInterval) {
                        clearInterval(connectionCheckInterval);
                        connectionCheckInterval = null;
                    }

                    if (provider && provider._websocket) {
                        try {
                            provider._websocket.close();
                        } catch (e) {}
                    }
                }
            }

            runCron().catch(e => {
                console.error(`[${new Date().toISOString()}] [FATAL]`, e);
                process.exitCode = 1;
            });

        
})();