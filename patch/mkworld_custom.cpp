/*
 * ZeroTier One - Network Virtualization Everywhere
 * Copyright (C) 2011-2016  ZeroTier, Inc.  https://www.zerotier.com/
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

 /*
  * This utility makes the World from the configuration specified below.
  * It probably won't be much use to anyone outside ZeroTier, Inc. except
  * for testing and experimentation purposes.
  *
  * If you want to make your own World you must edit this file.
  *
  * When run, it expects two files in the current directory:
  *
  * previous.c25519 - key pair to sign this world (key from previous world)
  * current.c25519 - key pair whose public key should be embedded in this world
  *
  * If these files do not exist, they are both created with the same key pair
  * and a self-signed initial World is born.
  */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>
#include <algorithm>
#include <chrono>
#include <set>
#include <stdexcept>
#include <cctype>

#include <node/Constants.hpp>
#include <node/World.hpp>
#include <node/C25519.hpp>
#include <node/Identity.hpp>
#include <node/InetAddress.hpp>
#include <osdep/OSUtils.hpp>

using namespace ZeroTier;
using json = nlohmann::json;

void validateRoots(const std::vector<World::Root>& roots) {
	if (roots.empty() || roots.size() > ZT_WORLD_MAX_ROOTS)
		throw std::runtime_error("invalid root count");
	std::set<uint64_t> addresses;
	for (const auto& root : roots) {
		if (!root.identity || root.identity.hasPrivate() || !root.identity.locallyValidate() ||
			!addresses.insert(root.identity.address().toInt()).second)
			throw std::runtime_error("roots must contain unique, valid public identities");
		if (root.stableEndpoints.empty() || root.stableEndpoints.size() > ZT_WORLD_MAX_STABLE_ENDPOINTS_PER_ROOT)
			throw std::runtime_error("invalid endpoint count");
		for (const auto& ep : root.stableEndpoints) {
			if ((!ep.isV4() && !ep.isV6()) || !ep.port())
				throw std::runtime_error("invalid IP/port endpoint");
		}
	}
}

World readWorld(const char* path) {
	std::string content;
	if (!OSUtils::readFile(path, content) || content.empty() || content.size() > ZT_WORLD_MAX_SERIALIZED_LENGTH)
		throw std::runtime_error("unable to read planet");
	Buffer<ZT_WORLD_MAX_SERIALIZED_LENGTH> buffer(content.data(), content.size());
	World world;
	if (world.deserialize(buffer, 0) != content.size() || world.type() != World::TYPE_PLANET || world.id() != ZT_WORLD_ID_EARTH)
		throw std::runtime_error("not a complete Earth planet");
	validateRoots(world.roots());
	return world;
}

json worldJson(const World& world) {
	json result = {{"type", "planet"}, {"id", world.id()}, {"timestamp", world.timestamp()}, {"roots", json::array()}};
	for (const auto& root : world.roots()) {
		char identity[ZT_IDENTITY_STRING_BUFFER_LENGTH];
		root.identity.toString(false, identity);
		json endpoints = json::array();
		for (const auto& ep : root.stableEndpoints) {
			char address[128];
			ep.toString(address);
			endpoints.push_back(address);
		}
		result["roots"].push_back({{"identity", identity}, {"stableEndpoints", endpoints}});
	}
	return result;
}

void printHelp() {
	printf("Usage: mkworld [options]\n");
	printf("Options:\n");
	printf("  -h, --help          Display this help message\n");
	printf("  -j, --json2bin      Convert from JSON file to world.bin\n");
	printf("  -b, --bin2json      Convert from world.bin to JSON format\n");
	printf("  --inspect FILE     Print public planet metadata as JSON (read-only)\n");
	printf("  --verify-update OLD NEW  Verify signature, world ID and increasing timestamp\n");
}

int jsonToBinary() {
	std::string previous, current;
	const bool havePrevious = OSUtils::readFile("previous.c25519", previous);
	const bool haveCurrent = OSUtils::readFile("current.c25519", current);
	std::string priorContent;
	const bool haveWorld = OSUtils::readFile("world.bin.previous", priorContent);
	if (havePrevious != haveCurrent || (haveWorld && !havePrevious)) {
		fprintf(stderr, "FATAL: existing worlds require both signing keys; refusing to replace keys\n");
		return 1;
	}
	if (!havePrevious && !haveCurrent) {
		C25519::Pair np(C25519::generate());
		previous = std::string();
		previous.append((const char*)np.pub.data, ZT_C25519_PUBLIC_KEY_LEN);
		previous.append((const char*)np.priv.data, ZT_C25519_PRIVATE_KEY_LEN);
		current = previous;
		if (!OSUtils::writeFile("previous.c25519", previous) || !OSUtils::writeFile("current.c25519", current))
			throw std::runtime_error("unable to write signing keys");
		fprintf(stderr, "INFO: created initial world keys: previous.c25519 and current.c25519 (both initially the same)" ZT_EOL_S);
	}

	if ((previous.length() != (ZT_C25519_PUBLIC_KEY_LEN + ZT_C25519_PRIVATE_KEY_LEN)) || (current.length() != (ZT_C25519_PUBLIC_KEY_LEN + ZT_C25519_PRIVATE_KEY_LEN))) {
		fprintf(stderr, "FATAL: previous.c25519 or current.c25519 empty or invalid" ZT_EOL_S);
		return 1;
	}
	C25519::Pair previousKP;
	memcpy(previousKP.pub.data, previous.data(), ZT_C25519_PUBLIC_KEY_LEN);
	memcpy(previousKP.priv.data, previous.data() + ZT_C25519_PUBLIC_KEY_LEN, ZT_C25519_PRIVATE_KEY_LEN);
	C25519::Pair currentKP;
	memcpy(currentKP.pub.data, current.data(), ZT_C25519_PUBLIC_KEY_LEN);
	memcpy(currentKP.priv.data, current.data() + ZT_C25519_PUBLIC_KEY_LEN, ZT_C25519_PRIVATE_KEY_LEN);

	// =========================================================================
	// EDIT BELOW HERE

	std::vector<World::Root> roots;

	const uint64_t id = ZT_WORLD_ID_EARTH;
	// World timestamps must increase whenever a planet is regenerated. A fixed
	// timestamp can cause clients to keep an older signed world indefinitely.
	uint64_t ts = static_cast<uint64_t>(
		std::chrono::duration_cast<std::chrono::milliseconds>(
			std::chrono::system_clock::now().time_since_epoch()).count());
	std::string previousWorldContent;
	if (OSUtils::readFile("world.bin.previous", previousWorldContent)) {
		try {
			Buffer<ZT_WORLD_MAX_SERIALIZED_LENGTH> previousWorldBuffer(previousWorldContent.data(), previousWorldContent.size());
			World previousWorld;
			if ((!previousWorld.deserialize(previousWorldBuffer, 0)) ||
				(previousWorld.type() != World::TYPE_PLANET) ||
				(previousWorld.id() != id)) {
				fprintf(stderr, "FATAL: world.bin.previous is not the expected planet" ZT_EOL_S);
				return 1;
			}
			if (previousWorld.timestamp() >= ts) {
				if (previousWorld.timestamp() == UINT64_MAX) {
					fprintf(stderr, "FATAL: previous world timestamp cannot be incremented" ZT_EOL_S);
					return 1;
				}
				ts = previousWorld.timestamp() + 1;
			}
		} catch (...) {
			fprintf(stderr, "FATAL: unable to deserialize world.bin.previous" ZT_EOL_S);
			return 1;
		}
	}

	std::string fileContent;
	if (!OSUtils::readFile("moon.json", fileContent)) {
		fprintf(stderr, "Failed to open config file." ZT_EOL_S);
		return 1;
	}

	// 解析JSON数据
	json config = json::parse(fileContent);
	if (!config.is_object() || !config.contains("roots") || !config["roots"].is_array())
		throw std::runtime_error("roots must be an array");

	for (auto& root : config["roots"]) {
		if (!root.is_object() || !root.contains("stableEndpoints") || !root["stableEndpoints"].is_array())
			throw std::runtime_error("stableEndpoints must be an array");
		roots.push_back(World::Root());
		roots.back().identity = Identity(root["identity"].get<std::string>().c_str());
		for (auto& endpoint : root["stableEndpoints"]) {
			const std::string value = endpoint.get<std::string>();
			const auto slash = value.find('/');
			if (slash == std::string::npos || slash == 0 || value.find('/', slash + 1) != std::string::npos)
				throw std::runtime_error("endpoint must be IP/port");
			const std::string port = value.substr(slash + 1);
			if (port.empty() || port.size() > 5 ||
				!std::all_of(port.begin(), port.end(), [](unsigned char ch) { return std::isdigit(ch); }) ||
				std::stoul(port) == 0 || std::stoul(port) > 65535)
				throw std::runtime_error("endpoint port must be 1..65535");
			roots.back().stableEndpoints.push_back(InetAddress(value.c_str()));
		}
	}
	validateRoots(roots);

	fprintf(stderr, "INFO: generating and signing id==%llu ts==%llu" ZT_EOL_S, (unsigned long long)id, (unsigned long long)ts);

	World nw = World::make(World::TYPE_PLANET, id, ts, currentKP.pub, roots, previousKP);
	if (haveWorld) {
		World old = readWorld("world.bin.previous");
		if (!old.shouldBeReplacedBy(nw)) {
			fprintf(stderr, "FATAL: new planet is not a valid signed update to the previous world\n");
			return 1;
		}
	}

	Buffer<ZT_WORLD_MAX_SERIALIZED_LENGTH> outtmp;
	nw.serialize(outtmp, false);
	World testw;
	testw.deserialize(outtmp, 0);
	if (testw != nw) {
		fprintf(stderr, "FATAL: serialization test failed!" ZT_EOL_S);
		return 1;
	}

	if (!OSUtils::writeFile("world.bin", std::string((const char*)outtmp.data(), outtmp.size())))
		throw std::runtime_error("unable to write world.bin");
	fprintf(stderr, "INFO: world.bin written with %u bytes of binary world data." ZT_EOL_S, outtmp.size());

	fprintf(stdout, ZT_EOL_S);
	fprintf(stdout, "#define ZT_DEFAULT_WORLD_LENGTH %u" ZT_EOL_S, outtmp.size());
	fprintf(stdout, "static const unsigned char ZT_DEFAULT_WORLD[ZT_DEFAULT_WORLD_LENGTH] = {");
	for (unsigned int i = 0; i < outtmp.size(); ++i) {
		const unsigned char* d = (const unsigned char*)outtmp.data();
		if (i > 0)
			fprintf(stdout, ",");
		fprintf(stdout, "0x%.2x", (unsigned int)d[i]);
	}
	fprintf(stdout, "};" ZT_EOL_S);
	return 0;
}

int binaryToJson() {
	// Read world.bin file into memory
	std::string binContent;
	if (!OSUtils::readFile("world.bin", binContent)) {
		fprintf(stderr, "Failed to open world.bin file." ZT_EOL_S);
		return 1;
	}

	// Deserialize the binary data into a World object
	Buffer<ZT_WORLD_MAX_SERIALIZED_LENGTH> binBuffer(binContent.data(), binContent.size());
	World world;
	if (!world.deserialize(binBuffer, 0)) {
		fprintf(stderr, "Failed to deserialize world.bin content." ZT_EOL_S);
		return 1;
	}

	// Create a JSON object to store the world data
	json worldJson;
	worldJson["type"] = world.type() == World::TYPE_PLANET ? "planet" :
		(world.type() == World::TYPE_MOON ? "moon" : "null");
	worldJson["id"] = world.id();
	worldJson["timestamp"] = world.timestamp();


	// Add roots array to the JSON object
	json rootsJson;
	for (const auto& root : world.roots()) {
		json rootJson;

		// Add identity to the root JSON object
		char identityStr[ZT_IDENTITY_STRING_BUFFER_LENGTH];
		root.identity.toString(false, identityStr); // Public identity only
		rootJson["identity"] = identityStr;

		// Add stableEndpoints array to the root JSON object
		json stableEndpointsJson;
		for (const auto& endpoint : root.stableEndpoints) {
			char ipStr[64];
			endpoint.toString(ipStr);
			stableEndpointsJson.push_back(ipStr);
		}
		rootJson["stableEndpoints"] = stableEndpointsJson;

		rootsJson.push_back(rootJson);
	}
	worldJson["roots"] = rootsJson;
	std::string jsonStr = worldJson.dump(4);
	printf("World JSON:\n%s\n", jsonStr.c_str());
	if (!OSUtils::writeFile("config.json", jsonStr.c_str(), jsonStr.size())) {
		fprintf(stderr, "Failed to write JSON data to config.json." ZT_EOL_S);
		return 1;
	}
	else {
		printf("JSON data successfully written to config.json." ZT_EOL_S);
	}
	return 0;
}


int main(int argc, char** argv)
{
	try {
	if (argc == 3 && std::string(argv[1]) == "--inspect") {
		printf("%s\n", worldJson(readWorld(argv[2])).dump(2).c_str());
		return 0;
	}
	if (argc == 4 && std::string(argv[1]) == "--verify-update") {
		World old = readWorld(argv[2]);
		const World candidate = readWorld(argv[3]);
		if (!old.shouldBeReplacedBy(candidate)) {
			fprintf(stderr, "FATAL: invalid signature, world ID or timestamp for update\n");
			return 1;
		}
		return 0;
	}
	bool json2bin = false;
	bool bin2json = false;

	for (int i = 1; i < argc; ++i) {
		std::string arg = argv[i];
		if (arg == "-h" || arg == "--help") {
			printHelp();
			return 0;
		}
		else if (arg == "-j" || arg == "--json2bin") {
			json2bin = true;
		}
		else if (arg == "-b" || arg == "--bin2json") {
			bin2json = true;
		}
		else {
			printHelp();
			return 1;
		}
	}

	if (!(json2bin || bin2json)) {
		// Default behavior: convert from JSON to world.bin
		json2bin = true;
	}

	if (json2bin && bin2json) {
		printf("Error: Cannot specify both JSON to binary and binary to JSON conversion options.\n");
		printHelp();
		return 1;
	}

	if (json2bin) {
		return jsonToBinary();
	}
	else if (bin2json) {
		return binaryToJson();
	}

	return 0;
	} catch (...) {
		fprintf(stderr, "FATAL: invalid world/configuration or I/O failure\n");
		return 1;
	}
}
