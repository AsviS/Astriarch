var should = require('should');

var Astriarch = require("./../public/js/astriarch/astriarch_loader");

var player1 = new Astriarch.Player(Astriarch.Player.PlayerType.Computer_Expert, "Player1");
var player2 = new Astriarch.Player(Astriarch.Player.PlayerType.Computer_Expert, "Player2");
var gameModel = new Astriarch.Model([player1, player2], {systemsToGenerate:2, planetsPerSystem:4, distributePlanetsEvenly: true, "turnTimeLimitSeconds":0});

describe('#Astriarch.Fleet.StarShip', function () {

	describe('StrengthBoostFromLevel()', function () {
		it('should not give a boost for level 0', function (done) {
			var ss1 = new Astriarch.Fleet.StarShip(Astriarch.Fleet.StarShipType.Battleship);
			ss1.StrengthBoostFromLevel().should.equal(0);
			done();
		});

		it('should give an appropriate boost based on levels', function (done) {
			var ss1 = new Astriarch.Fleet.StarShip(Astriarch.Fleet.StarShipType.Battleship);
			ss1.ExperienceAmount = ss1.BaseStarShipStrength / 2;
			ss1.Level().level.should.equal(1);
			var strengthBoost = ss1.StrengthBoostFromLevel();
			console.log("Boost for level 1: ", strengthBoost);
			strengthBoost.should.equal(ss1.BaseStarShipStrength / 4);
			var levelExpBoosts = [16, 32, 40, 47, 52, 57, 61, 64, 67];
			for(var i = 0; i < levelExpBoosts.length; i++) {
				var levelExpBoost = levelExpBoosts[i];
				ss1.ExperienceAmount += ss1.ExperienceAmount + Math.round(ss1.ExperienceAmount/2);
				var level = ss1.Level().level;
				level.should.equal(i + 2);
				strengthBoost = ss1.StrengthBoostFromLevel();
				console.log("Level: ", level, "exp:", ss1.ExperienceAmount, "boost:", strengthBoost);
				strengthBoost.should.equal(levelExpBoost);
			}
			done();
		});
	});
});