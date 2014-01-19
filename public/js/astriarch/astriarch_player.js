var Astriarch = Astriarch || require('./astriarch_base');

/**
 * A Player represents either the main player or computer players
 * @constructor
 */
Astriarch.Player = function(/*PlayerType*/ playerType, /*string*/ name) {

	this.Id = Astriarch.Player.Static.NEXT_PLAYER_ID++;
	
	this.Type = playerType;//PlayerType

	this.Name = name;

	this.Resources = new Astriarch.Player.PlayerResources();

	this.Color = new Astriarch.Util.ColorRGBA(0, 255, 0, 255);//green

	this.LastTurnFoodNeededToBeShipped = 0;//this is for computers to know how much gold to keep in surplus for food shipments

	this.OwnedPlanets = {};//Dictionary<int, Planet>
	this.KnownClientPlanets = {};//Dictionary<int, ClientPlanet>
	this.LastKnownPlanetFleetStrength = {};//new Dictionary<int, LastKnownFleet>

	this.PlanetBuildGoals = {};//Dictionary<int, PlanetProductionItem>

	this.HomePlanet = null;//Planet

	this.FleetsInTransit = [];//List<Fleet>

	this.fleetsArrivingOnUnownedPlanets = {};//Dictionary<int, Fleet>//indexed by planet id

};

Astriarch.Player.Static = {NEXT_PLAYER_ID:1};

/**
 * sets the players rgba color
 * @this {Astriarch.Player}
 */
Astriarch.Player.prototype.SetColor = function(/*Astriarch.Util.ColorRGBA*/ colorNew)	{
	Astriarch.Util.GetImageData(colorNew);
	this.Color = colorNew;
};

/**
 * returns an array of the Owned Planets sorted by population and improvement count descending
 * @this {Astriarch.Player}
 * @return {Array.<Astriarch.Planet>}
 */
Astriarch.Player.prototype.GetOwnedPlanetsListSorted = function()	{
	var sortedOwnedPlanets = [];
	for(var i in this.OwnedPlanets)
	{
		sortedOwnedPlanets.push(this.OwnedPlanets[i]);
	}
	sortedOwnedPlanets.sort(Astriarch.Planet.PlanetPopulationImprovementCountComparerSortFunction);
	return sortedOwnedPlanets;
};

/**
 * the total food on all owned planets for this player
 * @this {Astriarch.Player}
 * @return {number}
 */
Astriarch.Player.prototype.TotalFoodAmount = function()	{
	var foodAmt = 0;
	for (var i in this.OwnedPlanets)
	{
		foodAmt += this.OwnedPlanets[i].Resources.FoodAmount;
	}
	return foodAmt;
};

/**
 * the total ore on all owned planets for this player
 * @this {Astriarch.Player}
 * @return {number}
 */
Astriarch.Player.prototype.TotalOreAmount = function()	{
	var oreAmt = 0;
	for (var i in this.OwnedPlanets)
	{
		oreAmt += this.OwnedPlanets[i].Resources.OreAmount;
	}
	return oreAmt;
};

/**
 * the total Iridium on all owned planets for this player
 * @this {Astriarch.Player}
 * @return {number}
 */
Astriarch.Player.prototype.TotalIridiumAmount = function()	{
	var iridiumAmt = 0;
	for (var i in this.OwnedPlanets)
	{
		iridiumAmt += this.OwnedPlanets[i].Resources.IridiumAmount;
	}
	return iridiumAmt;
};

/**
 * adds a fleet to the fleets landing on unowned planets object
 * @this {Astriarch.Player}
 */
Astriarch.Player.prototype.AddFleetArrivingOnUnownedPlanet = function(/*Planet*/ p, /*Fleet*/ f) {
	if (!this.fleetsArrivingOnUnownedPlanets[p.Id])
	{
		this.fleetsArrivingOnUnownedPlanets[p.Id] = f;
	}
	else//merge fleet with existing
	{
		this.fleetsArrivingOnUnownedPlanets[p.Id].MergeFleet(f);
	}
};

/**
 * returns and clears our index of fleets arriving on unowned planets
 * @this {Astriarch.Player}
 * @return {Array.<Astriarch.Fleet>} list of fleets arriving on unowned planets
 */
Astriarch.Player.prototype.GatherFleetsArrivingOnUnownedPlanets = function() {
	var unownedPlanetFleets = new Array();
	for (var i in this.fleetsArrivingOnUnownedPlanets)
	{
		unownedPlanetFleets.push(this.fleetsArrivingOnUnownedPlanets[i]);
	}
	this.fleetsArrivingOnUnownedPlanets = {}; //Dictionary<int, Fleet>
	return unownedPlanetFleets;//returns List<Fleet>
};

/**
 * returns true if the player owns the planet passed in
 * @this {Astriarch.Player}
 * @return {boolean} 
 */
Astriarch.Player.prototype.GetPlanetIfOwnedByPlayer = function(/*ClientPlanet*/ p) {
	var planet = null;
	if(p.Id in this.OwnedPlanets) {
		planet = this.OwnedPlanets[p.Id];
	}

	return planet;
};

/**
 * returns true if the player has explored the planet passed in
 * @this {Astriarch.Player}
 * @return {boolean} 
 */
Astriarch.Player.prototype.PlanetTypeIfKnownByPlayer = function(/*ClientPlanet*/ p) {
	var planetTypeIfKnownByPlayer = null;
	if (p.Id in this.KnownClientPlanets)
		planetTypeIfKnownByPlayer = this.KnownClientPlanets[p.Id].Type;

	return planetTypeIfKnownByPlayer;
};

/**
 * returns true if the planet already has reinforcements arriving
 * @this {Astriarch.Player}
 * @return {boolean} 
 */
Astriarch.Player.prototype.PlanetContainsFriendlyInboundFleet = function(/*Planet*/ p) {
	for (var i in this.FleetsInTransit)
	{
		if (this.FleetsInTransit[i].DestinationHex.PlanetContainedInHex.Id == p.Id)
		{
			return true;
		}
	}

	return false;
};

/**
 * returns the total population of the player's planets
 * @this {Astriarch.Player}
 * @return {number} 
 */
Astriarch.Player.prototype.GetTotalPopulation = function() {
	var totalPop = 0;

	for(var i in this.OwnedPlanets)
	{
		totalPop += this.OwnedPlanets[i].Population.length;
	}

	return totalPop;
};

/**
 * returns the total food production of the players owned planets
 * @this {Astriarch.Player}
 * @return {number} 
 */
Astriarch.Player.prototype.GetTotalFoodProductionPerTurn = function() {
	var totalFoodProduction = 0;

	for (var i in this.OwnedPlanets)
	{
		totalFoodProduction += this.OwnedPlanets[i].ResourcesPerTurn.FoodAmountPerTurn;
	}

	return totalFoodProduction;
};

Astriarch.Player.PlayerType = { 
	Human: 0,
	Computer_Easy: 1,
	Computer_Normal: 2,
	Computer_Hard: 3,
	Computer_Expert: 4
};

/**
 * PlayerResources is the resources at the global level
 * @constructor
 */
Astriarch.Player.PlayerResources = function() {
	//players start with some resources
	this.GoldAmount = 3;
	this.GoldRemainder = 0.0;
};

/**
 * accumulates remainders over one for PlayerResources
 * @this {Astriarch.Player.PlayerResources}
 */
Astriarch.Player.PlayerResources.prototype.AccumulateResourceRemainders = function() {
	if (this.GoldRemainder >= 1.0)
	{
		this.GoldAmount += Math.floor(this.GoldRemainder / 1.0);
		this.GoldRemainder = this.GoldRemainder % 1;
	}
};

/**
 * if amount to spend is higher than total gold, subtracts gold to zero, and returns how much was spent
 * @this {Astriarch.Player.PlayerResources}
 * @return {number} the amount of gold actually spent
 */
Astriarch.Player.PlayerResources.prototype.SpendGoldAsPossible = function(/*int*/ amountToSpend) {
	if (this.GoldAmount >= amountToSpend)
	{
		this.GoldAmount = this.GoldAmount - amountToSpend;
		return amountToSpend;
	}
	else
	{
		var spent = amountToSpend - this.GoldAmount;
		this.GoldAmount = 0;
		return spent;
	}
};

/**
 * Options for the game
 * @constructor
 */
Astriarch.Player.PlayerGameOptions = function() {
	this.ShowHexGrid = false;
	this.ShowPlanetaryConflictPopups = true;

};