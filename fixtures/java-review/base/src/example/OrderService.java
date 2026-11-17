package example;

import java.util.List;
import java.util.Map;

public final class OrderService {
  private final Map<String, List<String>> orders = Map.of("active", List.of("A1", "A2"));

  public List<String> itemIds(String customerId) {
    if (!orders.containsKey(customerId)) {
      return List.of();
    }
    return orders.get(customerId);
  }
}
