package main

import (
	"encoding/json"
	"testing"
)

func TestAdoptConfigSelectsRequestedServer(t *testing.T) {
	raw := []byte(`{
		"outbounds": [
			{"tag":"proxy-cz","protocol":"vless","settings":{"vnext":[{"address":"cz.example","port":443},{"address":"de.example","port":443}]}},
			{"tag":"direct","protocol":"freedom","settings":{}}
		],
		"routing":{"rules":[
			{"type":"field","outboundTag":"proxy-cz"},
			{"type":"field","outboundTag":"direct"}
		]}
	}`)
	outboundIndex, nodeIndex := 0, 1
	cfg, err := adoptConfig(raw, &serverMetadata{
		Host:          "de.example",
		Port:          443,
		OutboundTag:   "proxy-cz",
		OutboundIndex: &outboundIndex,
		NodeKey:       "vnext",
		NodeIndex:     &nodeIndex,
	})
	if err != nil {
		t.Fatal(err)
	}

	outbounds := cfg.root["outbounds"].([]any)
	selected := outbounds[0].(map[string]any)
	settings := selected["settings"].(map[string]any)
	nodes := settings["vnext"].([]any)
	node := nodes[0].(map[string]any)
	if node["address"] != "de.example" {
		t.Fatalf("selected node = %v, want de.example", node["address"])
	}

	routing := cfg.root["routing"].(map[string]any)
	rules := routing["rules"].([]any)
	proxyRule := rules[0].(map[string]any)
	directRule := rules[1].(map[string]any)
	if proxyRule["outboundTag"] != "proxy-cz" {
		t.Fatalf("proxy routing target = %v, want selected outbound tag", proxyRule["outboundTag"])
	}
	if directRule["outboundTag"] != "direct" {
		t.Fatalf("direct routing target changed: %v", directRule["outboundTag"])
	}
}

func TestAdoptConfigRoutesBalancerRulesToSelectedServer(t *testing.T) {
	raw := []byte(`{
		"outbounds":[
			{"tag":"cz","protocol":"vless","settings":{"vnext":[{"address":"cz.example","port":443}]}},
			{"tag":"de","protocol":"vless","settings":{"vnext":[{"address":"de.example","port":443}]}}
		],
		"routing":{
			"rules":[{"type":"field","balancerTag":"auto"}],
			"balancers":[{"tag":"auto","selector":["cz","de"]}]
		}
	}`)
	outboundIndex := 1
	cfg, err := adoptConfig(raw, &serverMetadata{
		OutboundIndex: &outboundIndex,
		Host:          "de.example",
		Port:          443,
	})
	if err != nil {
		t.Fatal(err)
	}

	routing := cfg.root["routing"].(map[string]any)
	rule := routing["rules"].([]any)[0].(map[string]any)
	if rule["outboundTag"] != "de" {
		t.Fatalf("balancer route target = %v, want de", rule["outboundTag"])
	}
	if _, exists := rule["balancerTag"]; exists {
		t.Fatal("selected-server route still uses the automatic balancer")
	}
}

func TestAdoptConfigRewritesProxyRulesToSelectedOutbound(t *testing.T) {
	raw := []byte(`{
		"outbounds":[
			{"tag":"cz","protocol":"vless","settings":{"vnext":[{"address":"cz.example","port":443}]}},
			{"tag":"de","protocol":"vless","settings":{"vnext":[{"address":"de.example","port":443}]}},
			{"tag":"direct","protocol":"freedom","settings":{}}
		],
		"routing":{"rules":[
			{"type":"field","outboundTag":"cz"},
			{"type":"field","outboundTag":"direct"}
		]}
	}`)
	outboundIndex := 1
	cfg, err := adoptConfig(raw, &serverMetadata{OutboundIndex: &outboundIndex})
	if err != nil {
		t.Fatal(err)
	}

	selected := cfg.root["outbounds"].([]any)[0].(map[string]any)
	if selected["tag"] != "de" {
		t.Fatalf("first outbound = %v, want selected outbound de", selected["tag"])
	}
	routing := cfg.root["routing"].(map[string]any)
	rules := routing["rules"].([]any)
	if got := rules[0].(map[string]any)["outboundTag"]; got != "de" {
		t.Fatalf("proxy routing target = %v, want selected outbound de", got)
	}
	if got := rules[1].(map[string]any)["outboundTag"]; got != "direct" {
		t.Fatalf("direct routing target changed: %v", got)
	}
}

func TestConnectionKeyDiffersForSelectedNodesInSameConfig(t *testing.T) {
	outboundIndex, czechNode, germanNode := 0, 0, 1
	config := json.RawMessage(`{"outbounds":[{"protocol":"vless"}]}`)
	base := request{
		Cmd:    "start",
		Config: config,
		Server: &serverMetadata{OutboundIndex: &outboundIndex, NodeIndex: &czechNode},
	}
	germany := base
	germany.Server = &serverMetadata{OutboundIndex: &outboundIndex, NodeIndex: &germanNode}
	if connectionKey(base) == connectionKey(germany) {
		t.Fatal("different selected nodes have the same connection key")
	}
}
