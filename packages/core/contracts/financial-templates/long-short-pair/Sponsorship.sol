// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.0;
import "./LoaLib.sol";

contract Sponsorship {
    LoaLib.Sponsor public sponsor; // sponsor
    uint256 public balance; // amount of wei staked in this contract
    uint256 public scoreRequirement; // pass mark to validate this contract
    uint256 public acceptanceRequirement; // percentage of learners that need to agree to this contract
    uint256 public minimumStake = 10000000000000000; // minimum stake in wei for this contract
    address public selectedSchool;

    constructor(string memory sponsorName) {
        require(bytes(sponsorName).length > 0, "Sponsor must have a name");
        sponsor.name = sponsorName;
        sponsor.delegate = msg.sender;
    }

    mapping(address => LoaLib.School) public schools;
    mapping(address => LoaLib.Learner) public learners;

    function stakeReward(uint256 score, uint256 acceptance) public payable {
        require(msg.sender == sponsor.delegate, "Only the sponsor may stake a reward.");
        require(scoreRequirement == 0 && acceptanceRequirement == 0, "A reward can not be staked more than once.");
        require(msg.value >= minimumStake, "A stake can not be less than 0.01 eth.");
        require(score > 0, "A score can not be 0.");
        require(acceptance > 0, "Acceptance must be greater than 0.");

        balance += msg.value;
        scoreRequirement = score;
        acceptanceRequirement = acceptanceRequirement;
    }

    function agreeToSponsorRequirement(LoaLib.Learner memory learner) public {
        require(
            msg.sender != sponsor.delegate && msg.sender != selectedSchool,
            "Only a learner may agree to the sponsor requirement."
        );
        require(selectedSchool != address(0x0), "A school must be selected before a learner can agree.");
        require(bytes(learner.name).length > 0, "Learner must have a name.");
        require(bytes(learner.name).length > 0, "Learner must have a name.");
        learners[msg.sender] = learner;
    }

    function addSchool(LoaLib.School memory school) public {
        require(msg.sender != sponsor.delegate, "The sponsor may not also be a school.");
        require(bytes(school.name).length > 0, "School must have a name");
        require(
            school.syllabus.questions.length == school.syllabus.answers.length,
            "Every question must have an answer."
        );
        require(scoreRequirement > 0, "A score requirement must be specified before a school can be added.");
        require(balance >= minimumStake, "The sponsor must first set a stake before a school can be added.");
        require(schools[msg.sender].delegate == address(0x0), "A school can not be added more than once.");

        schools[msg.sender] = school;
    }

    function selectSchool(address schoolAddress) public returns (address selected) {
        require(msg.sender == sponsor.delegate, "Only the sponsor may select a school.");
        require(selectedSchool == address(0x0), "A school can not be selected when one is already selected.");
        require(schools[schoolAddress].delegate == schoolAddress, "A school address must exist.");
        require(
            schools[schoolAddress].sponsor == address(0x0),
            "A school can not be selected if it already has a sponsor."
        );
        require(scoreRequirement > 0, "A score requirement must be specified before a school can be selected.");
        require(balance > minimumStake, "A stake of at least 0.01 ether must be set before a school can be selected.");

        if (schools[schoolAddress].delegate == schoolAddress) {
            schools[schoolAddress].sponsor = msg.sender;
            selected = schoolAddress;
        }

        return selected;
    }
}
