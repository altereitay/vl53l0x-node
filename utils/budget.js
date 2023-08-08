const calcCommonBudget = (budgetUs, enables, timeouts) => {
    if (enables.tcc) {
        budgetUs += timeouts.msrcDssTccUs + 590 //TccOverhead
    }

    if (enables.dss) {
        budgetUs += 2 * (timeouts.msrcDssTccUs + 690) //DssOverhead
    } else if (enables.msrc) {
        budgetUs += timeouts.msrcDssTccUs + 660 //MsrcOverhead
    }

    if (enables.preRange) {
        budgetUs += timeouts.preRangeUs + 660 //PreRangeOverhead
    }

    return budgetUs
}

module.exports = {calcCommonBudget};