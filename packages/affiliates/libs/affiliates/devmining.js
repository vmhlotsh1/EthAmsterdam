const highland = require("highland");
const moment = require("moment");
const Promise = require("bluebird");
const assert = require("assert");
const lodash = require("lodash");

const { getWeb3, ConvertDecimals } = require("@uma/common");
const web3 = getWeb3();
const { toWei, toBN, fromWei } = web3.utils;

const { EmpBalancesHistory } = require("../processors");
const { Prices } = require("../models");
const { DecodeLog } = require("../contracts");

module.exports = ({ queries, coingecko, synthPrices, firstEmpDate }) => {
  assert(queries, "requires queries class");
  assert(coingecko, "requires coingecko api");
  assert(synthPrices, "requires synthPrices api");

  // use firstEmpDate as a history cutoff when querying for events. We can safely say no emps were deployed before Jan of 2020.
  firstEmpDate = firstEmpDate || moment("2020-01-01", "YYYY-MM-DD").valueOf();

  async function getBalanceHistory(empAddress, start, end, empAbi) {
    assert(empAddress, "requires empAddress");
    assert(empAbi, "requires empAbi");
    // stream is a bit more optimal than waiting for entire query to return as array
    // We need all logs from beginning of time. This could be optimized by deducing or supplying
    // the specific emp start time to narrow down the query.
    const stream = await queries.streamLogsByContract(empAddress, start, end);
    const decode = DecodeLog(empAbi);
    const balancesHistory = EmpBalancesHistory();
    await highland(stream)
      .map((log) => {
        return decode(log, {
          blockNumber: log.block_number,
          blockTimestamp: moment(log.block_timestamp.value).valueOf(),
          ...log,
        });
      })
      .doto((log) => balancesHistory.handleEvent(log.blockNumber, log))
      .last()
      .toPromise(Promise);

    // finalize makes sure the last snapshot is taken once all data has been handled
    balancesHistory.finalize();

    return balancesHistory;
  }
  // This now requires an array of tuples in order to handle varying versions of the EMP
  // [
  //   [empAddress, empAbi]
  // ]
  async function getAllBalanceHistories(empAddresses = [], start, end) {
    return Promise.reduce(
      empAddresses,
      async (result, [empAddress, empAbi]) => {
        result.push([empAddress, await getBalanceHistory(empAddress, start, end, empAbi)]);
        return result;
      },
      []
    );
  }
  // Gets the value of collateral currency in USD.
  async function getCoingeckoPriceHistory(address, currency = "usd", start, end) {
    const result = await coingecko.getHistoricContractPrices(address, currency, start, end);
    return Prices(result);
  }

  // returns a price history where everything is "price" in USD. Reports this as a natural number, not scaled to eth
  function getDefaultPriceHistory(price = 1) {
    // this inserts a single price at time 1. All lookups will converge to 1 for any time.
    return Prices([[1, Number(price)]]);
  }

  // the fallback requires a different value calculation, so this is probably the cleanest way to "switch"
  // between value by and value by usd. The function to calculate value is passed along with the data.
  async function getSyntheticPriceHistoryWithFallback(empAddress, start, end, syntheticAddress, fallbackPrice) {
    // this will throw if the feed isnt available (among other errors probably)
    try {
      return [await getSyntheticPriceHistory(empAddress, start, end), calculateValue];
    } catch (err) {
      console.error(empAddress, "synthetic price failed", err.message);
    }
    try {
      if (fallbackPrice) {
        console.error(empAddress, "using fallback price", fallbackPrice);
        return [getDefaultPriceHistory(fallbackPrice), calculateValueFromUsd];
      }
      return [await getCoingeckoPriceHistory(syntheticAddress, "usd", start, end), calculateValueFromUsd];
    } catch (err) {
      console.error(empAddress, "coingecko price failed", err.message);
    }
    throw new Error(`Unable to get a price for EMP: ${empAddress} and Synth: ${syntheticAddress}`);
  }

  // Need to convert seconds to MS
  function decodePrice(input) {
    return [input[0] * 1000, input[1]];
  }
  // Gets the value of synthetics in collateral currency.
  async function getSyntheticPriceHistory(address, start, end) {
    const result = await synthPrices.getHistoricSynthPrices(address, start, end);
    const fixedPrices = result.map(decodePrice);
    return Prices(fixedPrices);
  }

  async function getBlocks(start, end) {
    const blocks = await queries.getBlocks(start, end, ["timestamp", "number"]);
    return blocks.map((block) => {
      return { ...block, timestamp: moment(block.timestamp.value).valueOf() };
    });
  }

  // Calculates the value of x `tokens` in USD based on `collateralPrice` in USD, `syntheticPrice` in collateral considering
  // the decimals of both the collateral and synthetic token.
  // this should output estimated usd value of the synthetic tokens with 18 decimals (in wei)
  function calculateValue(tokens, collateralPrice, syntheticPrice, collateralTokenDecimal, syntheticTokenDecimal) {
    return toBN(tokens.toString())
      .mul(toBN(syntheticPrice.toString()))
      .mul(toBN(toWei(collateralPrice.toString())))
      .div(
        toBN("10")
          .pow(toBN(syntheticTokenDecimal.toString()))
          .mul(toBN(toWei("1")))
      );
  }
  // Calculates value of x tokens based on syntheticPrice in usd  ( from a coingecko feed)
  // copies the same api from the original calculateValue but doesnt use all params
  // should output the price of tokens measured in usd in wei
  function calculateValueFromUsd(...args) {
    // have to do this because eslint wont pass and wont ignore unused vars. These params need to be
    // identical to calculateValue so the calls can be interchangeable.
    const [tokens, , syntheticPrice, , syntheticTokenDecimal] = args;
    // EMP API has changed, now synthetics are not always 18 decimals. We have to normalize them to 18 before value calc.
    const tokensNormalized = ConvertDecimals(syntheticTokenDecimal, 18, web3)(tokens.toString());
    return tokensNormalized.mul(toBN(toWei(syntheticPrice.toFixed(18)))).div(toBN(toWei("1")));
  }

  function toChecksumAddress(address) {
    assert(address, "requires an eth address");
    return web3.utils.toChecksumAddress(address);
  }

  function validateEmpInput(empValue) {
    assert(
      lodash.isArray(empValue),
      "Each EMP whitelisted is expected to be an array in the form [empAddress, rewardAddress, empAbi]"
    );
    assert(
      empValue.length >= 3,
      "Each EMP whitelisted is expected to be an array in the form [empAddress, rewardAddress, empAbi]"
    );
    return empValue;
  }

  // pure function to separate out queries from calculations
  // this is adapted from scrips/example-contract-deployer-attributation.js
  function calculateRewards({
    empWhitelist = [],
    snapshotSteps = 1,
    totalRewards,
    collateralTokenPrices,
    collateralTokenDecimals,
    syntheticTokenPricesWithValueCalculation,
    syntheticTokenDecimals,
    blocks,
    balanceHistories,
  }) {
    assert(empWhitelist, "requires empWhitelist");
    assert(collateralTokenPrices, "requires collateral token prices prices");
    assert(syntheticTokenPricesWithValueCalculation, "requires synthetic token prices with value function");
    assert(blocks, "requires blocks");
    assert(balanceHistories, "requires balanceHistories");

    balanceHistories = new Map(balanceHistories);
    let startBlock, endBlock;

    // Lookup payout address by emp address
    const empLookup = new Map(empWhitelist);

    const rewardsPerBlock = toBN(toWei(totalRewards.toString())).div(toBN(blocks.length));
    const payoutPerSnapshot = rewardsPerBlock.mul(toBN(snapshotSteps));
    const valuePerSnapshot = blocks.reduce((result, block, index) => {
      if (index % snapshotSteps !== 0) return result;
      if (startBlock == null) startBlock = block;
      endBlock = block;
      const { timestamp, number } = block;
      const valueByEmp = empWhitelist.reduce((result, [empAddress], empIndex) => {
        try {
          const { tokens, isExpired } = balanceHistories.get(empAddress).history.lookup(number);

          // if EMP was expired this block, dont include it in further calculations.
          if (isExpired) {
            return result;
          }

          const [syntheticTokenPrices, syntheticValueCalculation] = syntheticTokenPricesWithValueCalculation[empIndex];
          const [, closestCollateralPrice] = collateralTokenPrices[empIndex].closest(timestamp);
          const [, closestSyntheticPrice] = syntheticTokenPrices.closest(timestamp);
          const totalTokens = Object.values(tokens).reduce((result, value) => {
            return result.add(toBN(value));
          }, toBN("0"));
          const value = syntheticValueCalculation(
            totalTokens,
            closestCollateralPrice,
            closestSyntheticPrice,
            collateralTokenDecimals[empIndex],
            syntheticTokenDecimals[empIndex]
          );
          result.push([empAddress, value]);
        } catch (err) {
          // this error is ok, it means we have block history before the emp had any events. Locked value is 0 at this block.
          if (err.message.includes("history does not go back far enough") || err.message.includes("history is empty")) {
            result.push([empAddress, "0"]);
          } else {
            console.error("error with emp", empAddress);
            throw err;
          }
        }
        return result;
      }, []);
      result.push(valueByEmp);
      return result;
    }, []);

    // lookup table from emp address -> deployer
    const empToDeployer = {};
    // Per snapshot calculate the associated amount that each deployer is entitled to.
    let finalPayouts = valuePerSnapshot.reduce(
      ({ deployerPayouts, empPayouts }, valueByEmp) => {
        const totalValueLocked = valueByEmp.reduce((result, [, value]) => {
          return result.add(toBN(value));
        }, toBN("0"));
        valueByEmp.forEach(([emp, value]) => {
          const payoutAddress = empLookup.get(emp);
          const contribution =
            totalValueLocked.toString() != "0"
              ? toBN(value) // eslint-disable-line indent
                  .mul(toBN(toWei("1"))) // eslint-disable-line indent
                  .div(totalValueLocked) // eslint-disable-line indent
              : toBN("0"); // eslint-disable-line indent
          const rewards = contribution.mul(payoutPerSnapshot).div(toBN(toWei("1")));

          // save lookup table of emp to deployer
          empToDeployer[emp] = payoutAddress;

          // calculate deployer rewards
          if (deployerPayouts[payoutAddress] == null) deployerPayouts[payoutAddress] = toBN("0");
          deployerPayouts[payoutAddress] = deployerPayouts[payoutAddress].add(rewards);

          // calculate per emp rewards
          if (empPayouts[emp] == null) empPayouts[emp] = toBN("0");
          empPayouts[emp] = empPayouts[emp].add(rewards);
        });
        return { deployerPayouts, empPayouts };
      },
      { deployerPayouts: {}, empPayouts: {} }
    );

    // Finally convert the final bignumber output to strings for each deployer.
    for (let address of Object.keys(finalPayouts.deployerPayouts)) {
      finalPayouts.deployerPayouts[address] = fromWei(finalPayouts.deployerPayouts[address]);
    }
    // Finally convert the final bignumber output to strings for export for emp contracts.
    for (let address of Object.keys(finalPayouts.empPayouts)) {
      finalPayouts.empPayouts[address] = fromWei(finalPayouts.empPayouts[address]);
    }

    return { startBlock, endBlock, empToDeployer, ...finalPayouts };
  }

  async function getRewards({
    totalRewards,
    startTime,
    endTime,
    empWhitelist = [],
    collateralTokens = [],
    collateralTokenDecimals = [],
    syntheticTokens = [],
    syntheticTokenDecimals = [],
    snapshotSteps = 1,
    fallbackPrices = [],
  }) {
    // API has changed, we need to validate input. Emps will be required to include payout address.
    // Want to give additional direction to user if this function is called directly.
    empWhitelist.forEach(validateEmpInput);

    fallbackPrices = new Map(fallbackPrices);

    // query all required data ahead of calcuation
    const [
      collateralTokenPrices,
      syntheticTokenPricesWithValueCalculation,
      blocks,
      balanceHistories,
    ] = await Promise.all([
      Promise.map(
        collateralTokens,
        async (address) => await getCoingeckoPriceHistory(address, "usd", startTime, endTime)
      ),
      Promise.mapSeries(
        empWhitelist,
        // each empwhitelist contains, [empaddress,deployeraddres], so we only care about empaddress
        async ([empAddress], i) =>
          await getSyntheticPriceHistoryWithFallback(
            empAddress,
            startTime,
            endTime,
            syntheticTokens[i],
            fallbackPrices.get(empAddress)
          )
      ),
      getBlocks(startTime, endTime),
      // Each empwhitelist contains, [empaddress,deployeraddres], balance histories expects array of just emp addresses
      getAllBalanceHistories(
        empWhitelist.map(([empaddress, , empAbi]) => [empaddress, empAbi]),
        firstEmpDate,
        endTime
      ),
    ]);

    return calculateRewards({
      startTime,
      endTime,
      empWhitelist,
      snapshotSteps,
      totalRewards,
      collateralTokenPrices,
      collateralTokenDecimals,
      syntheticTokenPricesWithValueCalculation,
      syntheticTokenDecimals,
      blocks,
      balanceHistories,
    });
  }

  return {
    getRewards,
    utils: {
      getBalanceHistory,
      getAllBalanceHistories,
      getCoingeckoPriceHistory,
      getSyntheticPriceHistory,
      getBlocks,
      calculateRewards,
      calculateValue,
      calculateValueFromUsd,
      validateEmpInput,
      toChecksumAddress,
    },
  };
};
