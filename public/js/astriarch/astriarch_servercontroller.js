var Astriarch = Astriarch || require('./astriarch_base');

Astriarch.ServerController = {

	BATTLE_RANDOMNESS_FACTOR: 4.0,//the amount randomness (chance) when determining fleet conflict outcomes, it is the strength multiplyer where the winner is guaranteed to win

	/// <summary>
	/// Finishes (takes) the turns for all AI opponents and builds resources for everyone
	/// </summary>
	/// <param name="gameModel">the full game model</param>
	EndTurns: function(gameModel)	{//Dictionary<Id, SerializableTurnEventMessage>

		gameModel.Turn.Next();

		var endOfTurnMessagesByPlayerId = {}; //Dictionary<Id, SerializableTurnEventMessage>

		for (var i in gameModel.Players)
		{
			var player = gameModel.Players[i];
			if (player.Type != Astriarch.Player.PlayerType.Human) {
				Astriarch.AI.ComputerTakeTurn(gameModel, player);
			} else {
				endOfTurnMessagesByPlayerId[player.Id] = [];
			}
		}

		//move ships called for all players before the rest of the end turn
		for (var i in gameModel.Players)
		{
			Astriarch.ServerController.moveShips(gameModel.Players[i]);
		}

		//could eventually prefer computer opponents
		for (var i in gameModel.Players)
		{
			var player = gameModel.Players[i];
			if (player.Type == Astriarch.Player.PlayerType.Human) {
				endOfTurnMessagesByPlayerId[player.Id] = endOfTurnMessagesByPlayerId[player.Id].concat(Astriarch.ServerController.endTurn(gameModel, player));
			} else {
				//don't add the messages
				Astriarch.ServerController.endTurn(gameModel, player);
			}
		}

		//TODO: could eventually only allow repairs if the planet has a certain improvement (i.e. space platform and colony)
		//and/or only repair slowly and/or charge gold for repairing damange (i.e. 1 gold per 4 damage
		//repair fleets on planets
		for (var i in gameModel.Planets) {
			gameModel.Planets[i].PlanetaryFleet.RepairFleet();
		}

		//resolve planetary conflicts
		for (var i in gameModel.Players) {
			var player = gameModel.Players[i];
			//resolve planetary conflicts deals with making sure the message pertains to the human players and adding them to the endOfTurnMessagesByPlayerId object
			Astriarch.ServerController.resolvePlanetaryConflicts(gameModel, player, endOfTurnMessagesByPlayerId);
		}

		//sort each end of turn messages array
		for(var id in endOfTurnMessagesByPlayerId){
			endOfTurnMessagesByPlayerId[id].sort(Astriarch.TurnEventMessage.TurnEventMessageComparerSortFunction);
		}

		return endOfTurnMessagesByPlayerId;
	},

	endTurn: function(gameModel, /*Player*/ player){//returns List<SerializableTurnEventMessage>
		var endOfTurnMessages = []; //List<SerializableTurnEventMessage>

		var totalPop = player.GetTotalPopulation();

		//this could all be done at the start of the turn also.
		endOfTurnMessages = endOfTurnMessages.concat(Astriarch.ServerController.eatAndStarve(gameModel, player, totalPop));

		if(player.Type == Astriarch.Player.PlayerType.Human) {
			Astriarch.ServerController.addLastStarShipToQueueOnPlanets(gameModel, player);
		}

		Astriarch.ServerController.generatePlayerResources(player);

		endOfTurnMessages = endOfTurnMessages.concat(Astriarch.ServerController.buildPlayerPlanetImprovements(player));

		endOfTurnMessages = endOfTurnMessages.concat(Astriarch.ServerController.growPlayerPlanetPopulation(player));

		return endOfTurnMessages;
	},

	moveShips: function(/*Player*/ player){
		//for each fleet in transit, move the fleet towards it's destination
		for (var i in player.FleetsInTransit)
		{
			player.FleetsInTransit[i].MoveFleet();
		}

		//for each planet and each outgoing fleet on that planet, move the fleet to the player's fleets in transit and move it
		for (var pi in player.OwnedPlanets)
		{
			var p = player.OwnedPlanets[pi];
			for (var i = p.OutgoingFleets.length - 1; i >= 0 ; i-- )
			{
				var f = p.OutgoingFleets[i];//Fleet
				player.FleetsInTransit.push(f);
				f.MoveFleet();
				p.OutgoingFleets.splice(i, 1);
			}
		}

		//land fleets arriving on owned planets
		//merge multiple friendly fleets arriving on unowned planets (before conflicts are resolved)
		for (var i = player.FleetsInTransit.length - 1; i >= 0; i--)
		{
			var playerFleet = player.FleetsInTransit[i];//Fleet
			if (playerFleet.TurnsToDestination == 0)
			{
				var destinationPlanet = playerFleet.DestinationHex.PlanetContainedInHex;//Planet
				if (destinationPlanet.Owner == player)
				{
					//merge/land fleet
					destinationPlanet.PlanetaryFleet.LandFleet(playerFleet, playerFleet.DestinationHex);
				}
				else
				{
					player.AddFleetArrivingOnUnownedPlanet(destinationPlanet, playerFleet);
				}
				player.FleetsInTransit.splice(i, 1);
			}
		}

	},

	//TODO: this is problematic right now if multiple players show up to battle at a 3rd players planet
	//  right now one player will attack, then the next one will, which prefers the 2nd player to attack
	resolvePlanetaryConflicts: function(gameModel, /*Player*/ player, endOfTurnMessagesByPlayerId) {//returns List<SerializableTurnEventMessage>

		//if any of the player's fleets in transit have reached their destination
		//  if the destination is not an owned planet, we need to resolve the conflict
		//  once conflicts are resolved, merge fleets to the fleets of the owned planet
		var unownedPlanetFleets = player.GatherFleetsArrivingOnUnownedPlanets();//List<Fleet>
		for (var i in unownedPlanetFleets)
		{
			var playerFleet = unownedPlanetFleets[i];//Fleet
			var destinationPlanet = playerFleet.DestinationHex.PlanetContainedInHex;//Planet

			//battle!
			var enemyFleet = destinationPlanet.PlanetaryFleet;//Fleet

			var enemyFleetStrength = enemyFleet.DetermineFleetStrength();

			var playerFleetStrength = playerFleet.DetermineFleetStrength();

			//this is for our turn event message, the PlanetaryConflictData constructor deals with cloning the fleets
			var planetaryConflictData = new Astriarch.TurnEventMessage.PlanetaryConflictData(destinationPlanet.Owner, enemyFleet, player, playerFleet);

			//determine strength differences
			// ServerController.BATTLE_RANDOMNESS_FACTOR = 4 in this case
			//if one fleet's strength is 4 (log base 16 4 = .5) times as strong or more that fleet automatically wins
			//  damage done to winning fleet is (strength of loser / strength Multiplier) +- some randomness
			//if neither fleet is 4 times as strong as the other or more, we have to roll the dice (preferring the stronger fleet) for who wins

			//if the player's fleet is destroyed the enemy (defender) always wins because you can't land fleets and capture the system without fleets


			//July 21st 2010, changed from pure statistics to BattleSimulator, still have this AttackingFleetChances code to show a percentage (for now as an estimation)



			if (enemyFleetStrength > playerFleetStrength * Astriarch.ServerController.BATTLE_RANDOMNESS_FACTOR)
			{
				planetaryConflictData.AttackingFleetChances = 1;
			}
			else if (playerFleetStrength > enemyFleetStrength * Astriarch.ServerController.BATTLE_RANDOMNESS_FACTOR)
			{
				planetaryConflictData.AttackingFleetChances = enemyFleetStrength == 0 ? 100 : 99;
			}
			else
			{
				//algorithm for estimated chance: BATTLE_RANDOMNESS_FACTOR here = 4
				// % chance = 50 + LOG base 4(greater fleet strength / lesser fleet strength)
				var randomnessUpperBounds = 0;
				if (playerFleetStrength > enemyFleetStrength)
				{
					//prefer player
					var extraPercentageChance = Math.log(playerFleetStrength / (enemyFleetStrength * 1.0)) / Math.log(Math.pow(Astriarch.ServerController.BATTLE_RANDOMNESS_FACTOR, 2)) * 100;//((playerFleetStrength - enemyFleetStrength) / (double)enemyFleetStrength) * 50;
					randomnessUpperBounds = 50 + Math.round(extraPercentageChance);
					planetaryConflictData.AttackingFleetChances = randomnessUpperBounds;
				}
				else
				{
					//prefer enemy
					var extraPercentageChanceEnemy = Math.log(enemyFleetStrength / (playerFleetStrength * 1.0)) / Math.log(Math.pow(Astriarch.ServerController.BATTLE_RANDOMNESS_FACTOR, 2)) * 100;//((enemyFleetStrength - playerFleetStrength) / (double)playerFleetStrength) * 50;
					randomnessUpperBounds = 50 + Math.round(extraPercentageChanceEnemy);
					planetaryConflictData.AttackingFleetChances = 100 - randomnessUpperBounds;
				}

			}

			//now actually simulate the battle
			var playerWins = Astriarch.BattleSimulator.SimulateFleetBattle(playerFleet, enemyFleet);//bool?
			//if at this point playerWins doesn't have a value it means that both fleets were destroyed, in that case the enemy should win because they are the defender of the planet
			if (playerWins === null || typeof playerWins == "undefined")
				playerWins = false;

			if (!playerWins)
			{
				//just kill the fleet
				//make sure this planet is now explored
				destinationPlanet.SetPlanetExplored(gameModel, player);
				playerFleet.SendFleetMergedOrDestroyed();

				//notify user of fleet loss or defense
				if (player.Type == Astriarch.Player.PlayerType.Human)//the attacking player is a human player and lost
				{

					//PlanetaryConflictData summarizes your attacking fleet, the enemy fleet and what was destroyed in the enemy fleet
					var message = "You lost a fleet attacking planet: " + destinationPlanet.Name;
					if(destinationPlanet.Owner != null)
						message = "You lost a fleet attacking " + destinationPlanet.Owner.Name + " at planet: " + destinationPlanet.Name;
					var tem = new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.AttackingFleetLost, destinationPlanet, message);
					planetaryConflictData.WinningFleet = enemyFleet.CloneFleet();
					tem.Data = new Astriarch.TurnEventMessage.SerializablePlanetaryConflictData(planetaryConflictData);
					endOfTurnMessagesByPlayerId[player.Id].push(tem);
				}

				if (destinationPlanet.Owner && destinationPlanet.Owner.Type == Astriarch.Player.PlayerType.Human)//the defending player is a human player and won
				{
					//PlanetaryConflictData summarizes the attacking fleet, your fleet and what was destroyed in your fleet
					var message = "You successfully defended against " + player.Name + " attacking planet: " + destinationPlanet.Name;
					var tem = new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.DefendedAgainstAttackingFleet, destinationPlanet, message);
					planetaryConflictData.WinningFleet = enemyFleet.CloneFleet();
					tem.Data = new Astriarch.TurnEventMessage.SerializablePlanetaryConflictData(planetaryConflictData);
					endOfTurnMessagesByPlayerId[destinationPlanet.Owner.Id].push(tem);
				}
			}
			else
			{
				var defendingPlayer = destinationPlanet.Owner;//Player

				//change planet ownership
				var goldLootMax = destinationPlanet.SetPlanetOwner(player);

				if(defendingPlayer)
				{
					//give the conquering player a chance to loot gold from the planet
					//based on how good the planet it is (class) and the amount refunded when everything was taken out of the build queue
					goldLootMax += Math.floor(Math.pow((destinationPlanet.Type + 1), 2));
					if(player.Resources.GoldAmount < goldLootMax)
						goldLootMax = defendingPlayer.Resources.GoldAmount;

					planetaryConflictData.GoldAmountLooted = Astriarch.NextRandom(0, Math.floor(goldLootMax + 1));
					defendingPlayer.Resources.GoldAmount -= planetaryConflictData.GoldAmountLooted;
					player.Resources.GoldAmount += planetaryConflictData.GoldAmountLooted;
				}

				//add in the other resources looted since the new player is now the owner
				planetaryConflictData.OreAmountLooted = destinationPlanet.Resources.OreAmount;
				planetaryConflictData.IridiumAmountLooted = destinationPlanet.Resources.IridiumAmount;
				planetaryConflictData.FoodAmountLooted = destinationPlanet.Resources.FoodAmount;

				//create a new fleet, we'll land and merge in a sec
				destinationPlanet.PlanetaryFleet = new Astriarch.Fleet();
				//merge/land fleet
				destinationPlanet.PlanetaryFleet.LandFleet(playerFleet, playerFleet.DestinationHex);

				if (defendingPlayer != null)
				{
					//set last known fleet strength
					destinationPlanet.SetPlayerLastKnownPlanetFleetStrength(gameModel, defendingPlayer);
				}

				//notify user of planet capture or loss
				if (player.Type == Astriarch.Player.PlayerType.Human)//the attacking player is a human player and won
				{
					//PlanetaryConflictData summarizes your attacking fleet, the enemy fleet and what was destroyed in your fleet
					var message = "Your fleet captured planet: " + destinationPlanet.Name;
					if(defendingPlayer != null)
						message = "Your fleet captured planet: " + destinationPlanet.Name + ", owned by: " + defendingPlayer.Name;
					var tem = new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.PlanetCaptured, destinationPlanet, message);
					planetaryConflictData.WinningFleet = playerFleet.CloneFleet();
					tem.Data = new Astriarch.TurnEventMessage.SerializablePlanetaryConflictData(planetaryConflictData);
					endOfTurnMessagesByPlayerId[player.Id].push(tem);
				}

				if (defendingPlayer && defendingPlayer.Type == Astriarch.Player.PlayerType.Human)//the defending player is a human player and lost
				{
					//planetaryConflictData summarizes your defending fleet, the enemy fleet and what was destroyed in the enemy fleet
					var message = player.Name + " captured your planet: " + destinationPlanet.Name;
					var tem = new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.PlanetLost, destinationPlanet, message);
					planetaryConflictData.WinningFleet = playerFleet.CloneFleet();
					tem.Data = new Astriarch.TurnEventMessage.SerializablePlanetaryConflictData(planetaryConflictData);
					endOfTurnMessagesByPlayerId[defendingPlayer.Id].push(tem);
				}
			}

		}

		console.log("RESOLVING PLANETARY CONFLICTS: ", endOfTurnMessagesByPlayerId);
		return endOfTurnMessagesByPlayerId;
	},

	eatAndStarve: function(gameModel, /*Player*/ player, /*int*/ totalPop) {
		var eotMessages = []; //List<SerializableTurnEventMessage>
		//for each planet player controls

		//if one planet has a shortage and another a surplus, gold will be spent (if possible) for shipping

		//determine food surplus and shortages
		//shortages will kill off a percentage of the population due to starvation depending on the amount of shortage

		player.LastTurnFoodNeededToBeShipped = 0;

		var foodDeficitByPlanet = {}; //Dictionary<PlanetId, int>();//for calculating starvation later
		var foodSurplusPlanets = []; //List<Planet>();//for costing shipments and starvation later

		//calculate surpluses and deficits
		for (var i in player.OwnedPlanets)
		{
			var p = player.OwnedPlanets[i];//Planet
			p.PlanetHappiness = Astriarch.Planet.PlanetHappinessType.Normal;//reset our happiness

			p.Resources.FoodAmount = p.Resources.FoodAmount - p.Population.length;//eat

			if (p.Resources.FoodAmount < 0)
			{
				var deficit = Math.abs(p.Resources.FoodAmount);
				foodDeficitByPlanet[p.Id] = deficit;//signify deficit for starvation
				p.Resources.FoodAmount = 0;

				player.LastTurnFoodNeededToBeShipped += deficit;//increment our food shipments needed so next turn we can ensure we have surplus gold
			}
			else if (p.Resources.FoodAmount > 0)//signify surplus for this planet for shipments
			{
				foodSurplusPlanets.push(p);
			}
		}

		var totalFoodShipped = 0;

		var protestingPlanetNames = "";
		var protestingPlanetCount = 0;
		var lastProtestingPlanet = null;//Planet

		//starve if we don't have surplus at other planets or can't afford to pay for shipments
		for (var planetId in foodDeficitByPlanet)
		{
			var planet = player.OwnedPlanets[planetId];
			var deficit = foodDeficitByPlanet[planetId];//KeyValuePair<PlanetId, int>
			var foodShortageTotal = deficit;
			var shippedAllResources = false;//if we shipped enough food to prevent starvation
			//first see if we can pay for any shipping and there are planets with surplus
			if (player.Resources.GoldAmount > 0 && foodSurplusPlanets.length > 0)//it will cost one gold per resource shipped
			{
				//look for a planet to send food from
				for (var s = 0; s < foodSurplusPlanets.length; s++)
				{
					var pSurplus = foodSurplusPlanets[s];//Planet
					var amountSpent = 0;

					if (foodShortageTotal > pSurplus.Resources.FoodAmount)//we can't get all our shortage from this one planet
					{
						amountSpent = player.Resources.SpendGoldAsPossible(pSurplus.Resources.FoodAmount);
					}
					else//we've can satisfy this deficit if we can pay for it, pay for as much shipping as we can
					{
						amountSpent = player.Resources.SpendGoldAsPossible(foodShortageTotal);
					}
					totalFoodShipped += amountSpent;

					foodShortageTotal = foodShortageTotal - amountSpent;
					pSurplus.Resources.FoodAmount = pSurplus.Resources.FoodAmount - amountSpent;

					if (pSurplus.Resources.FoodAmount == 0)//remove it for faster processing
					{
						foodSurplusPlanets.splice(s, 1);
						s--;
					}

					if (foodShortageTotal == 0)//we shipped enough food
					{
						shippedAllResources = true;
						break;
					}

				}
			}

			if (!shippedAllResources)
			{
				var foodShortageRatio = foodShortageTotal / (totalPop * 1.0);
				//starvation
				//there is a food shortage ratio chance of loosing one population,
				//if you have 4 pop and 2 food you have a 1 in 2 chance of loosing one
				//otherwise people just slowly starve
				var looseOne = (Astriarch.NextRandom(0, 100) < Math.round(foodShortageRatio * 100));
				if (looseOne)
				{
					var riotReason = ".";//for shortages
					if (player.Resources.GoldAmount <= 0 && foodSurplusPlanets.length != 0)
						riotReason = ", insufficient Gold to ship Food.";
					//notify user of starvation
					planet.PlanetHappiness = Astriarch.Planet.PlanetHappinessType.Riots;
					eotMessages.push(new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.FoodShortageRiots, planet, "Riots over food shortages killed one population on planet: " + planet.Name + riotReason));
					if (planet.Population.length > 0)
					{
						planet.Population.pop();
						//don't have to update planet stats based on population here because we'll do it later
					}
				}
				else//reduce the population a bit
				{
					if (planet.Population.length > 0)
					{
						planet.PlanetHappiness = Astriarch.Planet.PlanetHappinessType.Unrest;

						var c = planet.Population[planet.Population.length - 1];//Citizen
						c.PopulationChange -= foodShortageRatio;
						if (c.PopulationChange <= -1.0)
						{
							//notify user of starvation
							eotMessages.push(new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.PopulationStarvation, planet, "You lost one population due to food shortages on planet: " + planet.Name));
							planet.Population.pop();
							//don't have to update planet stats based on population here because we'll do it later
						}
						else
						{
							protestingPlanetCount++;

							if (protestingPlanetNames != "")
								protestingPlanetNames += ", ";
							protestingPlanetNames += planet.Name;

							lastProtestingPlanet = planet;
						}
					}
				}

				//have to check to see if we removed the last pop and loose this planet from owned planets if so
				if (planet.Population.length == 0)
				{
					//notify user of planet loss
					eotMessages.push(new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.PlanetLostDueToStarvation, planet, "You have lost control of " + planet.Name + " due to starvation"));

					planet.SetPlanetOwner(null);

					//set last known fleet strength
					planet.SetPlayerLastKnownPlanetFleetStrength(gameModel, player);
				}
			}
		}

		if (protestingPlanetCount > 0)
		{
			var protestingPlanetReason = ".";
			if (player.Resources.GoldAmount <= 0 && foodSurplusPlanets.length != 0)
				protestingPlanetReason = ", insufficient Gold to ship Food.";
			var planetPluralized = "planet: ";
			if (protestingPlanetCount > 1)
				planetPluralized = "planets: ";
			//notify user of population unrest
			eotMessages.push(new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.InsufficientFood, lastProtestingPlanet, "Population unrest over lack of Food on " + planetPluralized + protestingPlanetNames + protestingPlanetReason));
		}


		if(totalFoodShipped != 0) {
			eotMessages.push(new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.FoodShipped, null, "You spent " + totalFoodShipped + " Gold shipping Food."));
		}

		//TODO: food shortages should further reduce other production, and pop reproduction amt?

		return eotMessages;
	},

	generatePlayerResources: function(/*Player*/ player) {
		//determine tax revenue (gold)
		//for now we generate 1/2 gold for each worker, farmer, or miner
		//TODO: later we may want to allow the user to control taxes vs. research

		var totalWorkers = 0, totalfarmers=0, totalMiners=0;
		for (var i in player.OwnedPlanets)
		{
			var p = player.OwnedPlanets[i];//Planet
			var pop = new Astriarch.Planet.PopulationAssignments();
			p.CountPopulationWorkerTypes(pop);
			totalWorkers += pop.Workers;
			totalfarmers += pop.Farmers;
			totalMiners += pop.Miners;
		}

		player.Resources.GoldRemainder += (totalWorkers + totalMiners + totalfarmers) / 2.0;
		player.Resources.AccumulateResourceRemainders();

		//generate planet resources
		for (var i in player.OwnedPlanets)
		{
			player.OwnedPlanets[i].GenerateResources();
		}

	},

	addLastStarShipToQueueOnPlanets: function(gameModel, /*Player*/ player)
	{
		for(var i in player.OwnedPlanets)
		{
			var p = player.OwnedPlanets[i];//Planet
			if (p.BuildLastStarShip && p.BuildQueue.length == 0 && p.StarShipTypeLastBuilt != null)
			{
				//check resources
				var s = new Astriarch.Planet.StarShipInProduction(p.StarShipTypeLastBuilt);

				if (player.Resources.GoldAmount - s.GoldCost > player.LastTurnFoodNeededToBeShipped &&
					player.TotalOreAmount() - s.OreCost >= 0 &&
					player.TotalIridiumAmount() - s.IridiumCost >= 0)
				{
					p.EnqueueProductionItemAndSpendResources(gameModel, s, player);
				}
			}
		}
	},

	buildPlayerPlanetImprovements: function(/*Player*/ player){//returns List<TurnEventMessage>
		var endOfTurnMessages = []; //List<TurnEventMessage>
		//build planet improvements
		for (var i in player.OwnedPlanets)
		{
			var p = player.OwnedPlanets[i];//Planet
			var buildQueueEmptyObject = {'buildQueueEmpty': false};
			endOfTurnMessages = endOfTurnMessages.concat(p.BuildImprovements(buildQueueEmptyObject));
			if (buildQueueEmptyObject['buildQueueEmpty'])//if the build queue was empty we'll increase gold based on planet production
			{
				if (p.ResourcesPerTurn.ProductionAmountPerTurn > 0)
				{
					player.Resources.GoldRemainder += p.ResourcesPerTurn.ProductionAmountPerTurn / 4.0;
					player.Resources.AccumulateResourceRemainders();
				}
			}
		}
		return endOfTurnMessages;
	},

	growPlayerPlanetPopulation: function(/*Player*/ player){//returns List<SerializableTurnEventMessage>
		var endOfTurnMessages = [];// List<SerializableTurnEventMessage>
		//population growth rate is based on available space at the planet and the amount currently there
		//as we fill up the planet, growth rate slows
		for (var i in player.OwnedPlanets)
		{
			var p = player.OwnedPlanets[i];//Planet
			var popCount = p.Population.length;
			//check if we can grow
			if (popCount > 0 && p.PlanetHappiness != Astriarch.Planet.PlanetHappinessType.Riots && (popCount < p.MaxPopulation() || p.Population[popCount - 1].PopulationChange < 1.0))
			{
				var growthRatio = popCount / 4.0 * ((p.MaxPopulation() - popCount) / 8.0);
				if (p.PlanetHappiness == Astriarch.Planet.PlanetHappinessType.Unrest)//unrest slows pop growth
					growthRatio = growthRatio / 2.0;
				var lastCitizen = p.Population[popCount - 1];//Citizen
				lastCitizen.PopulationChange += growthRatio;
				if (lastCitizen.PopulationChange >= 1.0)
				{
					//notify user of growth
					endOfTurnMessages.push(new Astriarch.SerializableTurnEventMessage(Astriarch.TurnEventMessage.TurnEventMessageType.PopulationGrowth, p, "Population growth on planet: " + p.Name));
					//grow
					lastCitizen.PopulationChange = 0;
					p.Population.push(new Astriarch.Planet.Citizen(p.Type));
					p.ResourcesPerTurn.UpdateResourcesPerTurnBasedOnPlanetStats();
				}
			}
		}

		return endOfTurnMessages;
	},

	CheckPlayersDestroyed: function(gameModel)	{

		var destroyedPlayers = [];//List<Player>();
		for (var i in gameModel.Players)
		{
			var player = gameModel.Players[i];//Player
			//a player is destroyed if they have no owned planets and no fleets in transit
			if (Astriarch.CountObjectKeys(player.OwnedPlanets) == 0 && player.FleetsInTransit.length == 0)
			{
				destroyedPlayers.push(player);
			}
		}

		for (var dpi in destroyedPlayers)
		{
			var destroyedPlayer = destroyedPlayers[dpi];
			gameModel.PlayersDestroyed.push(destroyedPlayer);
			for(var i = gameModel.Players.length-1; i >= 0; i--) {
				if(gameModel.Players[i] == destroyedPlayer) {
					gameModel.Players.splice(i, 1);
				}
			}
		}

		return destroyedPlayers;
	},

	CalculateEndGamePoints: function(gameModel, playerId, opponentOptions, /*bool*/ playerWon) {

		var player = null;
		for (var i in gameModel.Players)
		{
			var p = gameModel.Players[i];//Player
			if(p.Id == playerId){
				player = p;
				break;
			}
		}

		if(!player){
			//player was destroyed
			for (var i in gameModel.PlayersDestroyed)
			{
				var p = gameModel.PlayersDestroyed[i];//Player
				if(p.Id == playerId){
					player = p;
					break;
				}
			}
		}

		var points = 0;

		var turnsTaken = gameModel.Turn.Number;
		if (turnsTaken > 1000)//some max, nobody should play this long?
			turnsTaken = 1000;

		var totalSystems = gameModel.SystemsToGenerate;
		var planetsPerSystem = Math.floor(gameModel.PlanetsPerSystem);
		var difficultyRating = totalSystems * planetsPerSystem - 8;


		for(var i in opponentOptions) {
			var oo = opponentOptions[i];
			switch(oo.type){
				case Astriarch.Player.PlayerType.Computer_Easy:
					difficultyRating += 1;
					break;
				case Astriarch.Player.PlayerType.Computer_Normal:
					difficultyRating += 2;
					break;
				case Astriarch.Player.PlayerType.Computer_Hard:
					difficultyRating += 3;
					break;
				case Astriarch.Player.PlayerType.Computer_Expert:
					difficultyRating += 4;
					break;
				case Astriarch.Player.PlayerType.Human:
					difficultyRating += 8;
					break;
			}
		}
		//max difficulty right now is (4 * 8) - 8 + (3 * 8) = 48
		//min is 1
		var minTurns = playerWon ? (6 * totalSystems * planetsPerSystem) : 6;
		var speedFactor = (difficultyRating + minTurns)/turnsTaken;

		var ownedPlanets = Astriarch.CountObjectKeys(player.OwnedPlanets);
		if (ownedPlanets == 0)
			ownedPlanets = 1;//so that we have points for loosers too
		var totalPopulation = player.GetTotalPopulation();

		if (totalPopulation == 0)
			totalPopulation = 1;//so that we have points for loosers too

		points = Math.round(((speedFactor * difficultyRating * ownedPlanets) + (totalPopulation * totalSystems)) * (playerWon ? 2 : 0.25) );

		return points;
	}


};

